import { config } from '../config.js'
import { blockstorePath, datastorePath } from '../store.js'
import { logger } from '../utils/logger.js'
import { availableStorageSize, dirSize } from '../utils/utils.js'
import { countByState, type FileState } from './registry.js'
import { fileRegistry } from './state.js'

export interface StorageMetrics {
  /** Bytes currently occupied by the blockstore directory. */
  blockstoreBytes: number
  /** Bytes currently occupied by the datastore directory. */
  datastoreBytes: number
  /**
   * Bytes of content protected by a pin.
   *
   * Estimated from the blocks this node wrote for each registered file. Blocks
   * shared between files are counted once per file, so the value is an upper
   * bound for deduplicated content.
   */
  pinnedBytes: number
  /**
   * Bytes garbage collection could reclaim right now: everything in the
   * blockstore that no pin protects, which is released files plus blocks cached
   * while serving downloads for other peers.
   */
  reclaimableBytes: number
  /** Free bytes on the filesystem that holds the blockstore. */
  availableBytes: number
  /** Free bytes uploads must never consume. */
  reservedBytes: number
  /** Free bytes uploads may still use. */
  usableBytes: number
  files: Record<FileState, number> & { total: number }
  /** Unix epoch milliseconds of the last successful refresh. */
  updatedAt: number | null
}

let cached: StorageMetrics = {
  blockstoreBytes: 0,
  datastoreBytes: 0,
  pinnedBytes: 0,
  reclaimableBytes: 0,
  availableBytes: 0,
  reservedBytes: config.storage.diskReserveBytes,
  usableBytes: 0,
  files: { temporary: 0, confirmed: 0, expired: 0, total: 0 },
  updatedAt: null
}

/**
 * Recompute the storage report.
 *
 * Directory scans and a full registry sweep are too expensive for a request
 * path, so this runs on the disk usage schedule and the API serves the cache.
 */
export async function refreshStorageMetrics(): Promise<StorageMetrics> {
  const [blockstoreBytes, datastoreBytes, availableBytes, records] = await Promise.all([
    dirSize(blockstorePath),
    dirSize(datastorePath),
    availableStorageSize(blockstorePath).then(Number),
    fileRegistry.all()
  ])

  const pinnedBytes = records
    .filter((record) => record.pinned)
    .reduce((total, record) => total + record.storedBytes, 0)

  const reservedBytes = config.storage.diskReserveBytes

  cached = {
    blockstoreBytes,
    datastoreBytes,
    pinnedBytes,
    reclaimableBytes: Math.max(0, blockstoreBytes - pinnedBytes),
    availableBytes,
    reservedBytes,
    usableBytes: Math.max(0, availableBytes - reservedBytes),
    files: { ...countByState(records), total: records.length },
    updatedAt: Date.now()
  }

  if (blockstoreBytes === 0 && pinnedBytes > 0) {
    // `dirSize` reports 0 for an unreadable directory as well as an empty one.
    // Watermark collection cannot work while that happens, so say so once per
    // scan rather than letting the collector silently never trigger.
    logger.warn(
      'Blockstore size reads as 0 while pinned content is registered. ' +
        'Watermark-based garbage collection cannot run until the scan succeeds.'
    )
  }

  return cached
}

/** Last computed storage report. Zeroed until the first refresh completes. */
export function getStorageMetrics(): StorageMetrics {
  return cached
}
