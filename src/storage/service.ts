import { unixfs } from '@helia/unixfs'
import { CID } from 'multiformats/cid'
import { config } from '../config.js'
import { helia, ifs } from '../helia.js'
import { logger } from '../utils/logger.js'
import { availableStorageSize } from '../utils/utils.js'
import { getNodesList } from '../utils/utils.js'
import { blockstorePath } from '../store.js'
import { mayDemote, placeFile, storageTargets, type Placement } from './placement.js'
import { isDirectlyPinned, pinFile, unpinFile } from './pinning.js'
import type { FileRecord, LockedFileRegistry } from './registry.js'
import {
  isUnderReplicated,
  replicate,
  requiredAcks,
  type PlacementOutcome,
  type ReplicationPeer,
  type ReplicationReport
} from './replication.js'
import {
  probeAccept,
  probeHave,
  requestCache,
  requestStore,
  type ReplicationHandlers,
  type ReplicationCallOptions
} from './replicationProtocol.js'
import { prepareRetrieval, retrievalTargets } from './retrieval.js'
import { PER_PEER_INTAKE_BYTES, reserveIntake } from './intakeBudget.js'
import {
  INTAKE_OVERSHOOT_BYTES,
  INTAKE_READ_CONCURRENCY,
  meteredBlocks,
  type TransferProgress
} from './meter.js'
import { claimedBytes, claimSpace, type Claim } from './reservation.js'
import { fileRegistry, incomingCopyLimiter } from './state.js'
import { nextSweepBatch } from './sweep.js'

const callOptions = (): ReplicationCallOptions => ({
  timeoutMs: config.replication.requestTimeoutMs
})

function selfPeerId(): string {
  return helia.libp2p.peerId.toString()
}

/**
 * The other ADAMANT nodes this one can place copies on.
 *
 * They come from the same `nodes` list that already seeds peer discovery, so a
 * replication peer needs no extra address: the multiaddr identifies it and the
 * libp2p handshake proves the peer id.
 */
export function getReplicationPeers(): ReplicationPeer[] {
  return getNodesList([selfPeerId()]).map((node) => ({
    name: node.name,
    peerId: node.peerId.toString(),
    multiAddr: node.multiAddr
  }))
}

function placementFor(cid: string, createdAt: number, peers: ReplicationPeer[]): Placement {
  return placeFile({
    cid,
    ageMs: Math.max(0, Date.now() - createdAt),
    tiers: config.replication.placement,
    selfPeerId: selfPeerId(),
    peerIds: peers.map((peer) => peer.peerId)
  })
}

/**
 * Place copies of a file on the nodes that should hold it, and record which of
 * them acknowledged.
 *
 * Failures are reported, never thrown: an upload that is already stored and
 * pinned locally stays valid when a peer is unavailable, and the repair job
 * retries later.
 */
export async function replicateFile(cid: string): Promise<ReplicationReport> {
  const record = await fileRegistry.get(cid)

  const report = await replicate({
    cid,
    ageMs: Math.max(0, Date.now() - (record?.createdAt ?? Date.now())),
    selfPeerId: selfPeerId(),
    peers: getReplicationPeers(),
    config: config.replication,
    store: (peer) => placeCopy(peer, cid),
    cacheOnly: async (peer) => {
      await requestCache(helia, peer.multiAddr, cid, callOptions())
    }
  })

  if (report.mode === 'quorum') {
    await fileRegistry.setReplicas(cid, report.replicas)

    if (!report.satisfied) {
      logger.warn(
        `Replication quorum not reached for ${cid}: ` +
          `${report.acknowledged}/${report.required} copies`
      )
    }
  }

  return report
}

/**
 * Connect to the nodes that should hold `cid` before reading it.
 *
 * A client asks whichever node it likes for a file, and that node is usually
 * not one of its holders. Placement tells it exactly which nodes to reach, so
 * the read does not depend on a holder happening to be connected already.
 */
export async function prepareFileRetrieval(cid: CID): Promise<void> {
  await prepareRetrieval(helia, cid, () =>
    retrievalTargets(cid.toString(), config.replication, selfPeerId(), getReplicationPeers())
  )
}

/**
 * Ask one peer to take a copy, and report what it agreed to.
 *
 * A peer that already holds the file needs nothing, and a peer with no room is
 * skipped after one short message rather than after a transfer it will refuse.
 * Repair runs on a schedule, so without those questions a peer that cannot take
 * a file is re-sent it forever.
 *
 * A peer that does not know this node refuses to become responsible for the
 * file, which is what happens to a node nobody has configured yet. Its content
 * would otherwise exist in one copy and disappear with it. So the file is
 * offered as an unpinned copy instead: the peer can serve it from then on, and
 * nothing is counted as durable that is not.
 */
async function placeCopy(peer: ReplicationPeer, cid: string): Promise<PlacementOutcome> {
  try {
    if (await probeHave(helia, peer.multiAddr, cid, callOptions())) {
      return 'stored'
    }

    if (!(await probeAccept(helia, peer.multiAddr, cid, callOptions()))) {
      throw new Error('peer has no room for another copy')
    }

    await requestStore(helia, peer.multiAddr, cid, callOptions())
    return 'stored'
  } catch (err) {
    if (!(err as Error).message.includes('Not authorized')) {
      throw err
    }

    await requestCache(helia, peer.multiAddr, cid, callOptions())
    return 'cached'
  }
}

/**
 * Pin content that is not in the registry yet and record it as durable.
 *
 * The DAG is pulled over libp2p if it is missing locally, bounded by the
 * replication request timeout so an unreachable CID cannot hang the caller.
 *
 * @param name Display name recorded for the file; defaults to its CID
 */
async function registerPinnedLocked(
  registry: LockedFileRegistry,
  cid: CID,
  name: string,
  previous: FileRecord | undefined
): Promise<FileRecord> {
  const signal = AbortSignal.timeout(config.replication.requestTimeoutMs)
  const createdPin = await pinFile(helia, cid, signal)

  try {
    // Everything is local after pinning, so the deduplicated DAG size is what
    // this node actually holds on disk for the file.
    const stats = await ifs.stat(cid, { extended: true, offline: true, signal })

    return (
      await registry.registerReplacing(
        {
          cid: cid.toString(),
          name,
          fileSize: Number(stats.size),
          storedBytes: Number(stats.deduplicatedDagSize)
        },
        { confirmationRequired: false, temporaryTtlMs: config.storage.temporaryTtlMs }
      )
    ).record
  } catch (err) {
    // A failed stat or datastore write must not leave a pin no lifecycle owns.
    if (createdPin && previous?.pinned !== true) {
      await unpinFile(helia, cid)
    }
    throw err
  }
}

async function registerPinned(cid: CID, name: string): Promise<FileRecord> {
  const key = cid.toString()
  return fileRegistry.withExclusiveCids([key], async (registry) =>
    registerPinnedLocked(registry, cid, name, await registry.get(key))
  )
}

/**
 * Make a file durable and place its copies.
 *
 * @param options `registerUnknown` decides what happens for a CID the node
 *   never accepted through an upload: the confirmation endpoint reports it as
 *   unknown, while an explicit pin request stores and registers it
 */
export async function confirmFile(
  cid: string,
  options: { registerUnknown?: boolean } = {}
): Promise<FileRecord | undefined> {
  const parsed = CID.parse(cid)
  const confirmed = await fileRegistry.withExclusiveCids([cid], async (registry) => {
    const current = await registry.get(cid)

    if (!current) {
      return options.registerUnknown === true
        ? registerPinnedLocked(registry, parsed, cid, current)
        : undefined
    }

    const createdPin = await pinFile(helia, parsed)

    try {
      return await registry.save({
        ...current,
        state: 'confirmed',
        expiresAt: null,
        confirmedAt: current.confirmedAt ?? Date.now(),
        pinned: true,
        heldLocally: true
      })
    } catch (err) {
      if (createdPin && current.pinned !== true) {
        await unpinFile(helia, parsed)
      }
      throw err
    }
  })

  if (!confirmed) {
    return undefined
  }

  await replicateFile(cid)
  return fileRegistry.get(cid)
}

/**
 * Acknowledgements a file needs, given the network it actually lives in.
 *
 * The upload path caps the configured quorum by the copies that can exist, so
 * reporting the raw configuration would show a file as permanently short of a
 * quorum it was never asked to reach: `ackQuorum: 4` cannot be answered by more
 * than three copies on a three-node network, and the upload that created the
 * file already counted it as satisfied.
 */
export function effectiveQuorum(cid: string, createdAt: number): number {
  if (!config.replication.enabled) {
    return 1
  }

  return requiredAcks(config.replication, placementFor(cid, createdAt, getReplicationPeers()))
}

/**
 * Release a file so garbage collection may reclaim it.
 * Blocks stay on disk until the collector runs, which keeps the action
 * reversible until then.
 */
export async function releaseFile(cid: string): Promise<FileRecord | undefined> {
  const parsed = CID.parse(cid)

  return fileRegistry.withExclusiveCids([cid], async (registry) => {
    const current = await registry.get(cid)
    const removedPin = await unpinFile(helia, parsed)

    if (!current) {
      return undefined
    }

    try {
      return await registry.save({
        ...current,
        state: 'expired',
        pinned: false,
        heldLocally: false
      })
    } catch (err) {
      // The lifecycle still promises protection when the datastore write did
      // not land, so restore the pin before exposing the failure.
      if (removedPin && current.pinned) {
        await pinFile(helia, parsed)
      }
      throw err
    }
  })
}

/** Store a copy requested by another ADAMANT node. */
export async function acceptReplica(cid: string): Promise<FileRecord> {
  // Pulling the DAG first is what bounds this. Pinning would fetch it too, but
  // with no limit on how many transfers run at once, how much space they may
  // take together, or how large the content may be. The `accept` probe that
  // normally precedes a `store` is an optimisation, not a guarantee: nothing in
  // the protocol requires it, and several peers can pass their own probe and
  // then transfer at the same time.
  await pullUnderIntakeLimits(cid)

  // Every block is local now, so pinning walks the blockstore rather than the
  // network.
  return registerPinned(CID.parse(cid), cid)
}

/**
 * Behaviour this node exposes on the replication protocol.
 *
 * Until file ownership is signed by the uploader, only the configured ADAMANT
 * nodes may ask this one to spend disk. That keeps the current deployment
 * closed, and is the piece an ownership signature replaces so that anyone can
 * run a node without being handed a shared secret.
 */
export function createReplicationHandlers(): ReplicationHandlers {
  return {
    isAuthorized: (peerId) => getReplicationPeers().some((peer) => peer.peerId === peerId),
    store: async (cid) => (await acceptReplica(cid)).storedBytes,
    have: async (cid) => isDirectlyPinned(helia, CID.parse(cid)),
    willAccept: hasRoomForAnotherCopy,
    cacheCopy: cacheFileLocally,
    onError: (message) => logger.warn(message),
    onRefused: (peerId, op) =>
      logger.info(`Refused "${op}" from an unknown peer ${peerId}; offering a cached copy instead`)
  }
}

/**
 * Whether this node can take another copy without eating into the reserve.
 *
 * The same reserve that refuses uploads refuses copies from peers, so a full
 * node stops being chosen instead of accepting content it cannot keep.
 */
export async function hasRoomForAnotherCopy(): Promise<boolean> {
  try {
    const available = Number(await availableStorageSize(blockstorePath))
    // Space already promised to work in progress is not free. Without this,
    // several transfers each see the same headroom and cross the reserve
    // together.
    return available - claimedBytes() > config.storage.diskReserveBytes
  } catch {
    return false
  }
}

/**
 * Pull a DAG into the blockstore under the limits a peer transfer carries: how
 * many may run at once, how much space they may take together, and how large
 * one may be.
 *
 * The slot is taken before free space is measured, so everything after it lives
 * in the guarded region — a filesystem error while reading capacity used to
 * leave the slot taken, and enough of them disabled intake until restart.
 *
 * Draining the content is what both fetches every block and bounds the
 * transfer, so this expects UnixFS file content. Every CID this node registers
 * is one: uploads add byte streams rather than files, which is what keeps a
 * directory wrapper out of the registry in the first place.
 *
 * @param progress Updated as bytes arrive, so a caller can still see what a
 *   failed transfer cost. A peer that sends almost everything and then aborts
 *   has spent the bandwidth either way.
 * @param limitBytes Most this transfer may bring in. Defaults to the aggregate
 *   request limit; a caller working against a budget passes what it reserved,
 *   so a transfer cannot outgrow the allowance that admitted it.
 * @returns Bytes pulled
 */
async function pullUnderIntakeLimits(
  cid: string,
  progress: TransferProgress = { bytes: 0 },
  limitBytes: number = config.storage.maxRequestSizeBytes
): Promise<number> {
  if (!incomingCopyLimiter.tryAcquire()) {
    throw new Error('Too many copies are already being received')
  }

  let claim: Claim | undefined

  try {
    // The size is unknown before the transfer, so the aggregate request limit
    // is claimed pessimistically and given back at the end.
    claim = claimSpace({
      // Plus what the limit can be overshot by, so the disk reserve covers what
      // can actually arrive rather than what was allowed.
      bytes: limitBytes + INTAKE_OVERSHOOT_BYTES,
      availableBytes: Number(await availableStorageSize(blockstorePath)),
      reserveBytes: config.storage.diskReserveBytes
    })

    if (claim === undefined) {
      throw new Error('No room for another copy')
    }

    const signal = AbortSignal.timeout(config.replication.requestTimeoutMs)

    // Draining the stream is what walks the DAG; the meter under UnixFS is what
    // counts and bounds the blocks that walk pulls in, including the structural
    // ones the stream never yields.
    const metered = unixfs({
      blockstore: meteredBlocks(helia.blockstore, progress, limitBytes)
    })

    // `blockReadConcurrency` is what the exporter honours; `CatOptions`
    // re-exports a narrower type that leaves it out, so the options are built
    // as a value rather than inline. Without it the exporter requests the whole
    // DAG before the meter can count a single byte, and the limit bounds
    // nothing at all.
    const readOptions = { signal, blockReadConcurrency: INTAKE_READ_CONCURRENCY }

    for await (const chunk of metered.cat(CID.parse(cid), readOptions)) {
      void chunk
    }

    return progress.bytes
  } finally {
    claim?.release()
    incomingCopyLimiter.release()
  }
}

/**
 * Hold a file for a peer without pinning or registering it.
 *
 * Draining the content is what fetches every block of the DAG, and it leaves
 * them exactly where a read would: unpinned, reclaimed when space is short. The
 * node can serve the file from now on without promising to keep it.
 *
 * This is the one operation any peer may ask for, so it also spends a budget
 * the caller cannot renew at will.
 *
 * @returns Bytes pulled
 */
export async function cacheFileLocally(cid: string, peerId: string): Promise<number> {
  // Reserved before a block is fetched rather than counted afterwards. A check
  // that only reads the counters lets every concurrent request see the same
  // figure and pass, and a transfer charged on completion costs a peer nothing
  // when it aborts after sending almost all of it.
  // Capped at the budget itself: a node configured to accept requests larger
  // than a peer's whole hourly allowance would otherwise refuse every copy
  // outright instead of allowing one at a time.
  const allowance = Math.min(config.storage.maxRequestSizeBytes, PER_PEER_INTAKE_BYTES)
  const reservation = reserveIntake(peerId, allowance)

  if (reservation === undefined) {
    throw new Error('Cache budget for this peer is spent')
  }

  const progress: TransferProgress = { bytes: 0 }

  try {
    // The transfer is bounded by what was reserved, not by the request limit.
    // Otherwise a node configured to accept requests larger than the allowance
    // lets a peer reserve part of a transfer and complete all of it, and the
    // budget only learns of the excess once it has already arrived. The
    // headroom comes off it, because the limit is noticed late.
    return await pullUnderIntakeLimits(
      cid,
      progress,
      Math.max(1, allowance - INTAKE_OVERSHOOT_BYTES)
    )
  } finally {
    // What actually crossed the network, finished or not.
    reservation.settle(progress.bytes)
  }
}

export interface RepairReport {
  checked: number
  underReplicated: number
  repaired: string[]
  stillMissing: string[]
  /** Files nobody was found holding, whose local blocks were pinned again. */
  rescued: string[]
}

/**
 * Take a released file back when no other node is holding it.
 *
 * Repair only looks at files a node holds, so a file handed over to peers that
 * later left is nobody's responsibility and disappears silently while every
 * registry still calls it confirmed.
 *
 * The check is cheap because it starts with a local lookup: a node can only
 * rescue a file whose blocks it still has, and blocks are kept until space runs
 * short, so shortly after a handover they usually are. Anything already
 * reclaimed is skipped without touching the network.
 */
async function rescueOrphanedFiles(
  records: FileRecord[],
  peers: ReplicationPeer[]
): Promise<string[]> {
  const self = selfPeerId()
  const rescued: string[] = []
  const byPeerId = new Map(peers.map((peer) => [peer.peerId, peer]))

  const candidates = nextSweepBatch(
    'rescue',
    records.filter((record) => record.state === 'confirmed' && !record.heldLocally)
  )

  for (const record of candidates) {
    const cid = CID.parse(record.cid)

    if (!(await helia.blockstore.has(cid))) {
      continue
    }

    const holders = storageTargets(placementFor(record.cid, record.createdAt, peers), self)
      .map((peerId) => byPeerId.get(peerId))
      .filter((peer): peer is ReplicationPeer => peer !== undefined)

    const answers = await Promise.all(
      holders.map(async (peer) => {
        try {
          return await probeHave(helia, peer.multiAddr, record.cid, callOptions())
        } catch {
          return false
        }
      })
    )

    if (answers.some(Boolean)) {
      continue
    }

    try {
      // Only worth pinning if the whole DAG is still here; an offline stat says
      // so without going near the network.
      await ifs.stat(cid, { extended: true, offline: true })

      // The record was chosen before the probes, which take as long as the
      // network does. Writing the snapshot back would undo whatever happened to
      // the file meanwhile — a re-upload, a release, an updated replica list —
      // so the pin and the state change happen together, against the record as
      // it is now.
      const kept = await fileRegistry.withExclusiveCids([record.cid], async (registry) => {
        const current = await registry.get(record.cid)

        if (
          current === undefined ||
          current.revision !== record.revision ||
          current.state !== 'confirmed' ||
          current.heldLocally
        ) {
          return undefined
        }

        const createdPin = await pinFile(helia, cid)

        try {
          return await registry.save({ ...current, pinned: true, heldLocally: true })
        } catch (err) {
          if (createdPin && current.pinned !== true) {
            await unpinFile(helia, cid)
          }
          throw err
        }
      })

      if (kept === undefined) {
        continue
      }

      rescued.push(record.cid)
      logger.warn(`No node was holding ${record.cid}; kept the local copy instead`)
    } catch {
      // The blocks are only partly here, so there is nothing to rescue
      continue
    }
  }

  return rescued
}

/**
 * Detect and repair under-replicated durable content.
 *
 * Only confirmed files this node still holds are considered: a temporary upload
 * may disappear by policy, and a file this node released is another node's
 * responsibility.
 */
export async function repairReplication(): Promise<RepairReport> {
  const report: RepairReport = {
    checked: 0,
    underReplicated: 0,
    repaired: [],
    stillMissing: [],
    rescued: []
  }

  if (!config.replication.enabled) {
    return report
  }

  const peers = getReplicationPeers()
  const self = selfPeerId()
  const records = await fileRegistry.all()
  const candidates = nextSweepBatch(
    'repair',
    records.filter((record) => record.state === 'confirmed' && record.heldLocally)
  )

  report.checked = candidates.length

  const byPeerId = new Map(peers.map((peer) => [peer.peerId, peer]))

  for (const record of candidates) {
    const placement = placementFor(record.cid, record.createdAt, peers)

    // `replicas` is a record of what peers once said. A holder that lost its
    // blockstore, restarted empty, or left the configuration never changes that
    // number, and the file would be considered healthy forever. Ask instead.
    const holders = storageTargets(placement, self)
      .map((peerId) => byPeerId.get(peerId))
      .filter((peer): peer is ReplicationPeer => peer !== undefined)

    const answers = await Promise.all(
      holders.map(async (peer) => {
        try {
          return (await probeHave(helia, peer.multiAddr, record.cid, callOptions()))
            ? peer.name
            : undefined
        } catch {
          return undefined
        }
      })
    )

    const live = answers.filter((name): name is string => name !== undefined)
    await fileRegistry.setReplicas(record.cid, live)

    if (!isUnderReplicated(live.length, placement, self)) {
      continue
    }

    report.underReplicated += 1
    const result = await replicateFile(record.cid)

    if (isUnderReplicated(result.replicas.length, placement, self)) {
      report.stillMissing.push(record.cid)
    } else {
      report.repaired.push(record.cid)
    }
  }

  report.rescued = await rescueOrphanedFiles(records, peers)

  return report
}

export interface DemotionReport {
  checked: number
  /** Files whose local copy was released because other nodes hold them. */
  demoted: string[]
  /** Files this node kept because the designated holders did not all confirm. */
  kept: string[]
}

/**
 * Release local copies of files that belong on other nodes.
 *
 * A copy is dropped only when this node is outside the file's designated
 * holders and every one of those holders confirms it has the file. The
 * designated set is derived from the CID and is the same on every node, so the
 * nodes that must keep a file never consider dropping it, and a file cannot
 * lose all of its copies to simultaneous decisions.
 *
 * Nothing is dropped while the network is no larger than the desired copy
 * count: there is nowhere for the copy to go, and every node is expected to
 * hold it.
 */
export async function demoteReleasableCopies(
  options: { dryRun?: boolean } = {}
): Promise<DemotionReport> {
  const report: DemotionReport = { checked: 0, demoted: [], kept: [] }

  if (!config.replication.enabled) {
    return report
  }

  const peers = getReplicationPeers()
  const self = selfPeerId()
  const byPeerId = new Map(peers.map((peer) => [peer.peerId, peer]))

  const candidates = nextSweepBatch(
    'demote',
    (await fileRegistry.all()).filter(
      (record) => record.state === 'confirmed' && record.heldLocally
    ),
    // A dry run must not take the batch: the real pass that follows would then
    // resume past the very files the operator was shown.
    { advance: options.dryRun !== true }
  )

  report.checked = candidates.length

  for (const record of candidates) {
    const placement = placementFor(record.cid, record.createdAt, peers)

    if (!mayDemote(placement)) {
      continue
    }

    const holders = storageTargets(placement, self)
      .map((peerId) => byPeerId.get(peerId))
      .filter((peer): peer is ReplicationPeer => peer !== undefined)

    if (holders.length < placement.copies) {
      report.kept.push(record.cid)
      continue
    }

    const confirmations = await Promise.all(
      holders.map(async (peer) => {
        try {
          return await probeHave(helia, peer.multiAddr, record.cid, callOptions())
        } catch {
          return false
        }
      })
    )

    if (!confirmations.every(Boolean)) {
      report.kept.push(record.cid)
      continue
    }

    if (options.dryRun === true) {
      report.demoted.push(record.cid)
      continue
    }

    const demoted = await fileRegistry.withExclusiveCids([record.cid], async (registry) => {
      const current = await registry.get(record.cid)

      if (
        current === undefined ||
        current.revision !== record.revision ||
        current.state !== 'confirmed' ||
        !current.heldLocally
      ) {
        return false
      }

      const parsed = CID.parse(record.cid)
      const removedPin = await unpinFile(helia, parsed)

      try {
        await registry.save({ ...current, pinned: false, heldLocally: false })
        return true
      } catch (err) {
        if (removedPin && current.pinned) {
          await pinFile(helia, parsed)
        }
        throw err
      }
    })

    if (demoted) {
      report.demoted.push(record.cid)
      logger.info(`Released the local copy of ${record.cid}; ${holders.length} peers hold it`)
    }
  }

  return report
}
