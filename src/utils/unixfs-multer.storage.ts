import { StorageEngine } from 'multer'
import * as e from 'express'
import { UnixFS } from '@helia/unixfs'
import { logger } from './logger.js'
import { UnixFsMulterFile } from './types.js'

export interface UnixfsStorageOptions {
  unixfs: UnixFS
  destination: (req: e.Request, file: Express.Multer.File) => string
  filename: (req: e.Request, file: Express.Multer.File) => string
}

export class UnixfsMulterStorage implements StorageEngine {
  constructor(private readonly options: UnixfsStorageOptions) {}

  _handleFile(
    req: e.Request,
    file: Express.Multer.File,
    callback: (error?: Error, info?: Partial<UnixFsMulterFile>) => void
  ): void {
    this.options.unixfs
      .addByteStream(file.stream)
      .then((cid) => {
        callback(undefined, { ...file, cid })
      })
      .catch((err) => {
        callback(err, undefined)
      })
  }

  _removeFile(
    req: e.Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void
  ): void {
    logger.info(`Need remove file ${file.originalname}`)
    callback(null)
  }
}
