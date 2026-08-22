import { StorageEngine } from 'multer'
import * as e from 'express'
import { unixfs } from '@helia/unixfs'
import { Readable, Transform } from 'node:stream'
import { logger } from './logger.js'
import { UnixFsMulterFile } from './types.js'
import { sanitizeFilename } from './sanitizeFilename.js'
import type { RequestSizeBudget } from '../storage/limits.js'
import type { UploadSession } from '../storage/uploadSession.js'

export interface UnixfsStorageOptions {
  /** Resolve the session that owns everything written by this request. */
  getSession: (req: e.Request) => UploadSession
}

/**
 * Wrap a part stream so that the aggregate request budget is enforced while the
 * bytes flow.
 *
 * `Content-Length` is checked before parsing starts, but a chunked request
 * declares no size, so the limit is applied here as well.
 */
function budgeted(stream: Readable, budget: RequestSizeBudget): Readable {
  const meter = new Transform({
    transform(chunk: Buffer, encoding, callback) {
      try {
        budget.consume(chunk.length)
        callback(null, chunk)
      } catch (err) {
        callback(err as Error)
      }
    }
  })

  return stream.pipe(meter)
}

/**
 * Multer storage engine that imports parts straight into the Helia blockstore.
 *
 * Every write goes through the request `UploadSession`, which records the
 * blocks the request created so they can be removed again if the request is
 * rejected, aborted, or fails after some files were already imported.
 */
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

    const session = this.options.getSession(req)
    const write = session.beginFile()

    unixfs({ blockstore: session.blockstore })
      .addByteStream(budgeted(file.stream, session.budget))
      .then((cid) => {
        callback(undefined, { ...file, cid, storedBytes: write.storedBytes })
      })
      .catch((err) => {
        callback(err, undefined)
      })
  }

  /**
   * Called by multer for every already-imported part when a request is aborted.
   *
   * Cleanup is performed for the whole session at once, because a partially
   * written part has no CID to remove individually.
   */
  _removeFile(
    req: e.Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void
  ): void {
    this.options
      .getSession(req)
      .cleanup()
      .then((removed) => {
        if (removed > 0) {
          logger.info(`Removed ${removed} blocks left by a rejected upload request`)
        }
        callback(null)
      })
      .catch((err) => {
        logger.error(`Upload cleanup failed: ${(err as Error).message}`)
        callback(null)
      })
  }
}
