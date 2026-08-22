import { StorageEngine } from 'multer'
import * as e from 'express'
import { UnixFS } from '@helia/unixfs'
import { logger } from './logger.js'
import { UnixFsMulterFile } from './types.js'
import { sanitizeFilename } from './sanitizeFilename.js'

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
   *
   * The filename never reaches the DAG, but it is still sanitized because it is
   * echoed back in the upload response and written to the log.
   */
  _handleFile(
    req: e.Request,
    file: Express.Multer.File,
    callback: (error?: Error, info?: Partial<UnixFsMulterFile>) => void
  ): void {
    file.originalname = sanitizeFilename(file.originalname)

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
    logger.info('Remove file requested')
    callback(null)
  }
}
