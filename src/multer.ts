import multer from 'multer'
import { ifs } from './helia.js'
import { config } from './config.js'
import { UnixfsMulterStorage } from './utils/unixfs-multer.storage.js'
import { createMultipartLimits } from './security/uploadLimits.js'

export const multerStorage = multer({
  storage: new UnixfsMulterStorage({
    unixfs: ifs,
    destination: () => '/',
    filename: (_req, file) => file.originalname
  }),
  limits: createMultipartLimits(config.uploadLimitSizeBytes, config.maxFileCount)
})
