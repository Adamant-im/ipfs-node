import { StorageEngine } from 'multer'
import * as e from 'express'
import { unixfs } from '@helia/unixfs'
import { Readable, Transform, pipeline } from 'node:stream'
import { logger } from './logger.js'
import { UnixFsMulterFile } from './types.js'
import { sanitizeFilename } from './sanitizeFilename.js'
import type { RequestSizeBudget } from '../storage/limits.js'
import type { UploadSession } from '../storage/uploadSession.js'

export interface UnixfsStorageOptions {
  /** Resolve the session that owns everything written by this request. */
  getSession: (req: e.Request) => UploadSession
}

/** A part stream being metered, and how much of it has gone by. */
interface MeteredStream {
  stream: Readable
  /** Bytes of this part that reached the importer. */
  readonly bytes: number
}

/**
 * Wrap a part stream so that the aggregate request budget is enforced while the
 * bytes flow, and count the part itself.
 *
 * `Content-Length` is checked before parsing starts, but a chunked request
 * declares no size, so the limit is applied here as well.
 *
 * The per-part count is the file's own size. Nothing else knows it: multer
 * fills `size` only for engines that report it, and the blocks written are not
 * the same number — re-uploading content this node already holds writes none at
 * all.
 */
function budgeted(stream: Readable, budget: RequestSizeBudget): MeteredStream {
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, encoding, callback) {
      try {
        budget.consume(chunk.length)
        bytes += chunk.length
        callback(null, chunk)
      } catch (err) {
        callback(err as Error)
      }
    }
  })

  pipeline(stream, meter, (err) => {
    if (err !== null && err !== undefined && !meter.destroyed) {
      meter.destroy(err)
    }
  })

  return {
    stream: meter,
    get bytes() {
      return bytes
    }
  }
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
    const metered = budgeted(file.stream, session.budget)

    unixfs({ blockstore: write.blockstore })
      .addByteStream(metered.stream)
      .then((cid) => {
        // `size` is what multer would have set for a disk engine, and what the
        // lifecycle record stores as the file's size. Leaving it unset wrote
        // records without one, which nothing noticed until the registry began
        // validating what it reads.
        callback(undefined, {
          ...file,
          cid,
          size: metered.bytes,
          storedBytes: write.storedBytes,
          protectedBytes: write.protectedBytes
        })
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
