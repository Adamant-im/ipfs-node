import { CID } from 'multiformats/cid'
import { config } from '../config.js'
import { helia, ifs } from '../helia.js'
import { logger } from '../utils/logger.js'
import { getNodesList } from '../utils/utils.js'
import { pinFile, unpinFile } from './pinning.js'
import {
  replicate,
  selectUnderReplicated,
  type ReplicationReport,
  type ReplicationTarget
} from './replication.js'
import type { FileRecord } from './registry.js'
import { fileRegistry } from './state.js'

/**
 * Peer nodes that can accept a copy.
 *
 * A node without `apiUrl` cannot be reached by the replication control plane
 * and is skipped, which keeps mixed configurations usable during a rollout.
 */
export function getReplicationTargets(): ReplicationTarget[] {
  return getNodesList([helia.libp2p.peerId.toString()])
    .filter((node): node is typeof node & { apiUrl: string } => typeof node.apiUrl === 'string')
    .map((node) => ({ name: node.name, apiUrl: node.apiUrl }))
}

/**
 * Push a copy of `cid` to the peer nodes and store the acknowledgements.
 *
 * Failures are reported, never thrown: an upload that is already stored and
 * pinned locally stays valid when a peer is unavailable, and the repair job
 * retries later.
 */
export async function replicateFile(cid: string): Promise<ReplicationReport> {
  const report = await replicate({
    cid,
    targets: getReplicationTargets(),
    config: config.replication,
    token: config.replication.token
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
 * Make a file durable and replicate it.
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

/**
 * Store a copy requested by another ADAMANT node.
 *
 * The DAG is pulled over libp2p and pinned before the response is sent, so an
 * acknowledgement means the copy is durable on this node.
 */
export async function acceptReplica(cid: string): Promise<FileRecord> {
  return registerPinned(CID.parse(cid), cid)
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
 * Only confirmed files are considered: temporary uploads may still disappear by
 * policy, so spending peer bandwidth on them is not worthwhile.
 */
export async function repairReplication(): Promise<RepairReport> {
  const report: RepairReport = { checked: 0, underReplicated: 0, repaired: [], stillMissing: [] }

  if (!config.replication.enabled) {
    return report
  }

  const confirmed = (await fileRegistry.all()).filter((record) => record.state === 'confirmed')

  report.checked = confirmed.length
  const candidates = selectUnderReplicated(confirmed, config.replication)
  report.underReplicated = candidates.length

  for (const record of candidates) {
    const result = await replicateFile(record.cid)

    if (result.satisfied && result.acknowledged >= config.replication.factor) {
      report.repaired.push(record.cid)
    } else {
      report.stillMissing.push(record.cid)
    }
  }

  return report
}
