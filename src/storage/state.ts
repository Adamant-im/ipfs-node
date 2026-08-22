import { config } from '../config.js'
import { datastore } from '../store.js'
import { ConcurrencyLimiter } from './limits.js'
import { FileRegistry } from './registry.js'

/**
 * Lifecycle registry of every file this node accepted.
 * It shares the node datastore and lives under its own key prefix.
 */
export const fileRegistry = new FileRegistry(datastore)

/** Guards how many uploads may write into the blockstore at the same time. */
export const uploadLimiter = new ConcurrencyLimiter(config.storage.maxConcurrentUploads)
