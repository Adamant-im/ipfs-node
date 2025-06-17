import multer from 'multer'

import { config } from './config.js'
import { ifs } from './helia.js'
import { UnixfsMulterStorage } from './utils/unixfs-multer.storage.js'

export const multerStorage = multer({
  storage: new UnixfsMulterStorage({
    unixfs: ifs,
    destination: () => '/',
    filename: (_, file) => file.originalname
  }),
  limits: { fileSize: config.uploadLimitSizeBytes }
})
