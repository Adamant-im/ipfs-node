import { UnixFS } from '@helia/unixfs'
import { Request } from 'express'
import { StorageEngine } from 'multer'

import { logger } from '../../utils/logger.js'
import { UnixFsMulterFile } from '../types.js'

export interface UnixfsStorageOptions {
  unixfs: UnixFS
  destination: (req: Request, file: Express.Multer.File) => string
  filename: (req: Request, file: Express.Multer.File) => string
}

export class UnixfsMulterStorage implements StorageEngine {
  constructor(private readonly options: UnixfsStorageOptions) {}

  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error?: Error, info?: Partial<UnixFsMulterFile>) => void
  ): void {
    this.options.unixfs
      .addByteStream(file.stream)
      .then((cid) => {
        callback(undefined, { ...file, cid })
      })
      .catch((error) => {
        callback(error, undefined)
      })
  }

  _removeFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void
  ): void {
    logger.info(`Need remove file ${file.originalname}`)
    callback(null)
  }
}
