import type { RequestHandler } from 'express'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { blockstore, blockstorePath } from '../store.js'
import { storageOperationLock, uploadLimiter } from '../storage/state.js'
import { parseCid } from '../utils/cid.js'
import { logger } from '../utils/logger.js'
import { availableStorageSize } from '../utils/utils.js'
import { createUploadAdmission } from './uploadAdmission.js'

export { getUploadSession } from './uploadAdmission.js'

/** Production upload admission wired to this node's stores and limits. */
export const admitUpload: RequestHandler = createUploadAdmission({
  storage: config.storage,
  limiter: uploadLimiter,
  operationLock: storageOperationLock,
  availableStorageSize: () => availableStorageSize(blockstorePath),
  blockstore: helia.blockstore,
  isPinned: (cid) => helia.pins.isPinned(cid),
  deleteBlock: (cid) => blockstore.delete(cid),
  parseCid,
  log: logger
})
