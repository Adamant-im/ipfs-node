import { CID } from 'multiformats/cid'
import { config } from '../config.js'
import { helia, ifs } from '../helia.js'
import { logger } from '../utils/logger.js'
import { getNodesList } from '../utils/utils.js'
import { mayDemote, placeFile, storageTargets, type Placement } from './placement.js'
import { isDirectlyPinned, pinFile, unpinFile } from './pinning.js'
import type { FileRecord } from './registry.js'
import {
  isUnderReplicated,
  replicate,
  type ReplicationPeer,
  type ReplicationReport
} from './replication.js'
import {
  probeHave,
  requestStore,
  type ReplicationHandlers,
  type ReplicationCallOptions
} from './replicationProtocol.js'
import { prepareRetrieval, retrievalTargets } from './retrieval.js'
import { fileRegistry } from './state.js'

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
    store: async (peer) => {
      await requestStore(helia, peer.multiAddr, cid, callOptions())
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
 * Pin content that is not in the registry yet and record it as durable.
 *
 * The DAG is pulled over libp2p if it is missing locally, bounded by the
 * replication request timeout so an unreachable CID cannot hang the caller.
 *
 * @param name Display name recorded for the file; defaults to its CID
 */
async function registerPinned(cid: CID, name: string): Promise<FileRecord> {
  const signal = AbortSignal.timeout(config.replication.requestTimeoutMs)

  await pinFile(helia, cid, signal)

  // Everything is local after pinning, so the deduplicated DAG size is what
  // this node actually holds on disk for the file.
  const stats = await ifs.stat(cid, { extended: true, offline: true, signal })

  return fileRegistry.register(
    {
      cid: cid.toString(),
      name,
      fileSize: Number(stats.size),
      storedBytes: Number(stats.deduplicatedDagSize)
    },
    { confirmationRequired: false, temporaryTtlMs: config.storage.temporaryTtlMs }
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
  const known = await fileRegistry.get(cid)

  if (!known && options.registerUnknown !== true) {
    return undefined
  }

  if (known) {
    await pinFile(helia, parsed)
    await fileRegistry.confirm(cid)
  } else {
    await registerPinned(parsed, cid)
  }

  await replicateFile(cid)
  return fileRegistry.get(cid)
}

/**
 * Release a file so garbage collection may reclaim it.
 * Blocks stay on disk until the collector runs, which keeps the action
 * reversible until then.
 */
export async function releaseFile(cid: string): Promise<FileRecord | undefined> {
  await unpinFile(helia, CID.parse(cid))
  return fileRegistry.release(cid)
}

/** Store a copy requested by another ADAMANT node. */
export async function acceptReplica(cid: string): Promise<FileRecord> {
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
    onError: (message) => logger.warn(message)
  }
}

export interface RepairReport {
  checked: number
  underReplicated: number
  repaired: string[]
  stillMissing: string[]
}

/**
 * Detect and repair under-replicated durable content.
 *
 * Only confirmed files this node still holds are considered: a temporary upload
 * may disappear by policy, and a file this node released is another node's
 * responsibility.
 */
export async function repairReplication(): Promise<RepairReport> {
  const report: RepairReport = { checked: 0, underReplicated: 0, repaired: [], stillMissing: [] }

  if (!config.replication.enabled) {
    return report
  }

  const peers = getReplicationPeers()
  const self = selfPeerId()
  const candidates = (await fileRegistry.all()).filter(
    (record) => record.state === 'confirmed' && record.heldLocally
  )

  report.checked = candidates.length

  for (const record of candidates) {
    const placement = placementFor(record.cid, record.createdAt, peers)

    if (!isUnderReplicated(record.replicas.length, placement, self)) {
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
export async function demoteReleasableCopies(): Promise<DemotionReport> {
  const report: DemotionReport = { checked: 0, demoted: [], kept: [] }

  if (!config.replication.enabled) {
    return report
  }

  const peers = getReplicationPeers()
  const self = selfPeerId()
  const byPeerId = new Map(peers.map((peer) => [peer.peerId, peer]))

  const candidates = (await fileRegistry.all()).filter(
    (record) => record.state === 'confirmed' && record.heldLocally
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

    await unpinFile(helia, CID.parse(record.cid))
    await fileRegistry.releaseLocalCopy(record.cid)
    report.demoted.push(record.cid)
    logger.info(`Released the local copy of ${record.cid}; ${holders.length} peers hold it`)
  }

  return report
}
