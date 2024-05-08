import { StorageEngine } from 'multer'
import * as e from 'express'
import { UnixFS } from '@helia/unixfs'
import { pino } from './logger.js'
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
    const folder = this.options.destination(req, file)
    const filename = this.options.filename(req, file)
    this.options.unixfs
      .addFile({
        path: `${folder}/${filename}`,
        content: file.stream
      })
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
    pino.logger.info(`Need remove file ${file.originalname}`)
    callback(null)
  }
}
