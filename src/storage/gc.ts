import { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'
import type { GarbageCollectionConfig } from './config.js'
import { isProtected, pinFile, unpinFile } from './pinning.js'
import { FileRegistry, isExpired, type FileRecord } from './registry.js'

export type Watermarks = Pick<GarbageCollectionConfig, 'highWatermarkBytes' | 'lowWatermarkBytes'>

export interface GcPlanInput {
  /** Current blockstore size in bytes. */
  blockstoreBytes: number
  watermarks: Watermarks
  /** Free bytes on the blockstore filesystem, when known. */
  availableBytes?: number
  /** Free bytes uploads must never consume, when known. */
  reserveBytes?: number
  /** Every registered file; confirmed files are filtered out by the planner. */
  records: FileRecord[]
  now?: number
}

/** Why blocks are being deleted, or why they are not. */
export type CollectionTrigger = 'none' | 'watermark' | 'disk-reserve' | 'forced'

export interface GcPlan {
  /** True once space is actually short. */
  shouldCollect: boolean
  /** What made collection necessary. */
  trigger: CollectionTrigger
  /** Files released by the TTL policy, independent of the watermarks. */
  expired: FileRecord[]
  /** Additional files evicted to bring the blockstore below the low watermark. */
  evicted: FileRecord[]
  /** Files that must survive the collection. */
  retained: FileRecord[]
  estimatedBytesAfter: number
}

/**
 * Decide what a collection run should release.
 *
 * Two independent rules are applied:
 *
 * 1. TTL: an abandoned upload is released once it outlives its expiry, whatever
 *    the blockstore size is.
 * 2. Watermarks: when the blockstore grows above the high watermark, or free
 *    space falls into the disk reserve, the oldest unconfirmed files are evicted
 *    until the estimate drops below the low watermark. Hysteresis between the
 *    two thresholds stops the collector from running on every tick.
 *
 * Confirmed files are never selected, so durable content cannot be reclaimed.
 */
export function planGarbageCollection(input: GcPlanInput): GcPlan {
  const now = input.now ?? Date.now()
  const { highWatermarkBytes, lowWatermarkBytes } = input.watermarks

  const confirmed = input.records.filter((record) => record.state === 'confirmed')
  const releasable = input.records.filter((record) => record.state !== 'confirmed')

  const expired = releasable.filter((record) => isExpired(record, now))
  const alive = releasable.filter((record) => !isExpired(record, now))

  let estimatedBytesAfter = input.blockstoreBytes
  for (const record of expired) {
    estimatedBytesAfter -= record.storedBytes
  }

  // Space is short when the blockstore passed its ceiling, or when the volume
  // itself is running out. The second case matters on a disk smaller than the
  // configured watermark, where the ceiling would never be reached.
  const overWatermark = input.blockstoreBytes > highWatermarkBytes
  const underReserve =
    input.availableBytes !== undefined &&
    input.reserveBytes !== undefined &&
    input.availableBytes < input.reserveBytes

  const shouldCollect = overWatermark || underReserve
  const trigger: CollectionTrigger = overWatermark
    ? 'watermark'
    : underReserve
      ? 'disk-reserve'
      : 'none'
  const evicted: FileRecord[] = []

  if (shouldCollect) {
    // Oldest first: the least recently accepted upload is evicted before newer
    // content that a client may still be waiting to confirm.
    const byAge = [...alive].sort((a, b) => a.createdAt - b.createdAt)

    for (const record of byAge) {
      if (estimatedBytesAfter <= lowWatermarkBytes) {
        break
      }

      evicted.push(record)
      estimatedBytesAfter -= record.storedBytes
    }
  }

  const releasedCids = new Set([...expired, ...evicted].map((record) => record.cid))

  return {
    shouldCollect,
    trigger,
    expired,
    evicted,
    retained: [...confirmed, ...alive.filter((record) => !releasedCids.has(record.cid))],
    estimatedBytesAfter: Math.max(0, estimatedBytesAfter)
  }
}

export interface GcReport {
  startedAt: number
  durationMs: number
  dryRun: boolean
  collected: boolean
  /** What made this run delete blocks, or why it did not. */
  trigger: CollectionTrigger
  blockstoreBytesBefore: number
  estimatedBytesAfter: number
  releasedCids: string[]
  retainedCids: string[]
  removedBlocks: number
  /**
   * Blocks deleted by this run, capped for readability.
   *
   * These identify blocks, not files: the blockstore addresses content by
   * multihash and rebuilds a CID with its own default codec, so an entry can
   * read differently from the CID a file was uploaded under.
   */
  removedCids: string[]
  /** Confirmed files whose pin was missing and was restored. */
  repairedPins: string[]
  /**
   * Confirmed files this node holds whose protection could not be established.
   *
   * A non-empty list means the run stopped before deleting anything.
   */
  unprotected: string[]
  errors: string[]
}

/** Number of removed CIDs kept in a report, to bound the response size. */
const MAX_REPORTED_CIDS = 1000

export interface GcRunOptions {
  node: IpfsNode
  registry: FileRegistry
  watermarks: Watermarks
  blockstoreBytes: number
  /** Free bytes on the blockstore filesystem. */
  availableBytes?: number
  /** Free bytes uploads must never consume. */
  reserveBytes?: number
  /** Report what would happen without unpinning or deleting anything. */
  dryRun?: boolean
  /** Collect even when the blockstore is below the high watermark. */
  force?: boolean
  /** Bounds the DAG walk when a missing pin has to be restored. */
  pinTimeoutMs?: number
  now?: number
  log?: (message: string) => void
}

/**
 * Release reclaimable files and delete every unpinned block.
 *
 * Helia collects the whole blockstore in one pass, so the amount reclaimed is
 * controlled by choosing which files lose their pin beforehand. Confirmed files
 * keep their pin, and a missing pin on confirmed content is restored before any
 * block is deleted.
 */
export async function runGarbageCollection(options: GcRunOptions): Promise<GcReport> {
  const startedAt = options.now ?? Date.now()
  const log = options.log ?? ((): void => {})
  const errors: string[] = []

  const records = await options.registry.all()

  const plan = planGarbageCollection({
    blockstoreBytes: options.blockstoreBytes,
    watermarks: options.watermarks,
    availableBytes: options.availableBytes,
    reserveBytes: options.reserveBytes,
    records,
    now: startedAt
  })

  const released = [...plan.expired, ...plan.evicted]

  // Releasing and deleting are separate decisions. Losing a pin is policy: the
  // file is no longer protected. Deleting is reclamation, and it waits until
  // space is actually short, so an unpinned block keeps serving reads for free
  // instead of being thrown away and fetched over the network again.
  const collect = options.force === true || plan.shouldCollect

  const report: GcReport = {
    startedAt,
    durationMs: 0,
    dryRun: options.dryRun === true,
    collected: false,
    trigger: options.force === true ? 'forced' : plan.trigger,
    blockstoreBytesBefore: options.blockstoreBytes,
    estimatedBytesAfter: plan.estimatedBytesAfter,
    releasedCids: released.map((record) => record.cid),
    retainedCids: plan.retained.map((record) => record.cid),
    removedBlocks: 0,
    removedCids: [],
    repairedPins: [],
    unprotected: [],
    errors
  }

  // Guard rail: durable content this node holds must be pinned before anything
  // is deleted. A file handed over to its designated holders is deliberately
  // unpinned here, so restoring its pin would undo the handover.
  const heldConfirmed = plan.retained.filter(
    (item) => item.state === 'confirmed' && item.heldLocally
  )

  for (const record of heldConfirmed) {
    try {
      const cid = CID.parse(record.cid)
      if (await isProtected(options.node, cid)) {
        continue
      }

      log(`Restoring the missing pin of the confirmed file ${record.cid}`)

      if (options.dryRun === true) {
        report.repairedPins.push(record.cid)
        continue
      }

      const signal =
        options.pinTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.pinTimeoutMs)

      await pinFile(options.node, cid, signal)
      await options.registry.setPinned(record.cid, true)

      // Recorded only once the pin is actually back, so the field cannot claim
      // a repair that did not happen.
      report.repairedPins.push(record.cid)
    } catch (err) {
      report.unprotected.push(record.cid)
      errors.push(`Pin check failed for ${record.cid}: ${(err as Error).message}`)
    }
  }

  if (options.dryRun === true) {
    report.durationMs = Date.now() - startedAt
    return report
  }

  // Collection deletes every unpinned block, so a confirmed file whose pin
  // could not be restored would be deleted by it. Nothing is unpinned and
  // nothing is deleted until every confirmed file this node holds is known to
  // be protected; the next run tries again.
  if (report.unprotected.length > 0) {
    log(`Collection abandoned: ${report.unprotected.length} confirmed files could not be protected`)
    report.durationMs = Date.now() - startedAt
    return report
  }

  const releasedCleanly: FileRecord[] = []

  for (const record of released) {
    try {
      await unpinFile(options.node, CID.parse(record.cid))
      await options.registry.release(record.cid)
      releasedCleanly.push(record)
    } catch (err) {
      errors.push(`Release failed for ${record.cid}: ${(err as Error).message}`)
    }
  }

  if (!collect) {
    // Nothing is deleted while there is room. The released blocks stay on disk,
    // unprotected, and keep answering reads until the space is needed.
    report.durationMs = Date.now() - startedAt
    return report
  }

  await options.node.gc({
    onProgress: (event) => {
      if (event.type === 'helia:gc:deleted') {
        report.removedBlocks += 1
        if (report.removedCids.length < MAX_REPORTED_CIDS) {
          report.removedCids.push(event.detail.toString())
        }
      }

      if (event.type === 'helia:gc:error') {
        errors.push(String(event.detail))
      }
    }
  })

  // Only files whose release succeeded lose their record. One that failed to
  // unpin still has blocks and a pin, and dropping its record would hide it
  // from the next run and from the storage report.
  for (const record of releasedCleanly) {
    try {
      await options.registry.remove(record.cid)
    } catch (err) {
      errors.push(`Registry cleanup failed for ${record.cid}: ${(err as Error).message}`)
    }
  }

  report.collected = true
  report.durationMs = Date.now() - startedAt
  log(
    `Garbage collection released ${released.length} files and removed ${report.removedBlocks} blocks`
  )

  return report
}
