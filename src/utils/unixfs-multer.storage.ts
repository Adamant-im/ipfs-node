import { StorageEngine } from 'multer'
import * as e from 'express'
import { UnixFS } from '@helia/unixfs'
import { logger } from './logger.js'
import { UnixFsMulterFile } from './types.js'

export interface UnixfsStorageOptions {
  unixfs: UnixFS
}

export class UnixfsMulterStorage implements StorageEngine {
  constructor(private readonly options: UnixfsStorageOptions) {}

  /**
   * Import an uploaded file into the blockstore and attach its CID to the
   * multer file record.
   *
   * `addByteStream` is used rather than `addFile`: since `@helia/unixfs` v4,
   * `addFile` wraps the content in a UnixFS directory and returns the directory
   * CID, which would change the CIDs this node has always issued. Adding the
   * raw byte stream reproduces the pre-migration CIDs exactly.
   */
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
