import { config } from '../config.js'
import { datastore } from '../store.js'
import { ConcurrencyLimiter } from './limits.js'
import { StorageOperationLock } from './operationLock.js'
import { FileRegistry } from './registry.js'

/**
 * Lifecycle registry of every file this node accepted.
 * It shares the node datastore and lives under its own key prefix.
 */
export const fileRegistry = new FileRegistry(datastore)

/** Keeps collection outside write-to-pin and copy-to-pin critical sections. */
export const storageOperationLock = new StorageOperationLock()

/** Guards how many uploads may write into the blockstore at the same time. */
export const uploadLimiter = new ConcurrencyLimiter(config.storage.maxConcurrentUploads)

/**
 * Share of the upload limit that incoming copies may occupy.
 *
 * Copies are held to a fraction of what clients get for two reasons. A copy
 * cannot declare its size before the transfer, so it claims the whole aggregate
 * request limit for its whole duration and over-claims disk far more than an
 * upload does. And refusing one is cheap: the sender still holds the file and
 * repair places another copy on the next pass, whereas refusing an upload is
 * visible to a person.
 */
export const COPY_INTAKE_SHARE = 4

/**
 * Copies a node accepts at once however small its upload limit is.
 *
 * A share alone collapses on a conservatively configured node: a quarter of
 * four is one, and then a single peer sending a two-file upload has its second
 * copy refused. The floor is what a fan-out needs to land, and the space claim
 * still refuses copies the disk cannot take, so raising it does not weaken the
 * reserve.
 */
export const COPY_INTAKE_FLOOR = 4

/**
 * Guards how many copies peers may push into the blockstore at once.
 *
 * A copy is an upload as far as the disk is concerned, and it arrives over
 * libp2p where the HTTP rate limiter does not apply, so it needs a limit of its
 * own.
 */
export const incomingCopyLimiter = new ConcurrencyLimiter(
  Math.max(COPY_INTAKE_FLOOR, Math.floor(config.storage.maxConcurrentUploads / COPY_INTAKE_SHARE))
)
