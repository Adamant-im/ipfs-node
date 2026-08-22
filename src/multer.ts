import multer from 'multer'
import { config } from './config.js'
import { getUploadSession } from './middleware/uploadGuards.js'
import { UnixfsMulterStorage } from './utils/unixfs-multer.storage.js'
import { createMultipartLimits } from './security/uploadLimits.js'

export const multerStorage = multer({
  storage: new UnixfsMulterStorage({ getSession: getUploadSession }),
  limits: createMultipartLimits(config.uploadLimitSizeBytes, config.maxFileCount)
})
