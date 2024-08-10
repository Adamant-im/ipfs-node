import multer from 'multer'
import { ifs } from './helia.js'
import { config } from './config.js'
import { UnixfsMulterStorage } from './utils/unixfs-multer.storage.js'

export const multerStorage = multer({
  storage: new UnixfsMulterStorage({
    unixfs: ifs,
    destination: (req, file) => '/',
    filename: (req, file) => file.originalname
  }),
  limits: { fileSize: config.uploadLimitSizeBytes }
})
