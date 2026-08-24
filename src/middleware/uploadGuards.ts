import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { blockstore, blockstorePath } from '../store.js'
import { checkRequestSize, parseContentLength } from '../storage/limits.js'
import { claimSpace } from '../storage/reservation.js'
import { uploadLimiter } from '../storage/state.js'
import { UploadSession } from '../storage/uploadSession.js'
import { parseCid } from '../utils/cid.js'
import { logger } from '../utils/logger.js'
import { availableStorageSize } from '../utils/utils.js'

const SESSION_KEY = Symbol('uploadSession')

type RequestWithSession = Request & { [SESSION_KEY]?: UploadSession }

/**
 * Session of the current upload request.
 *
 * Throws when called outside an admitted upload, which would otherwise let
 * blocks be written with nobody owning their cleanup.
 */
export function getUploadSession(req: Request): UploadSession {
  const session = (req as RequestWithSession)[SESSION_KEY]

  if (!session) {
    throw new Error('Upload session is missing. The upload guards did not run for this request.')
  }

  return session
}

/**
 * Admission control for uploads.
 *
 * Runs before the multipart parser so that a request which cannot be stored is
 * refused before any block reaches the blockstore. It enforces the concurrent
 * upload limit, the aggregate request size and the disk reserve, then attaches
 * the session that owns cleanup for whatever the request writes.
 *
 * The per-file size and the file count are enforced by the parser itself; see
 * `createMultipartLimits`.
 */
export const admitUpload: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const { storage } = config

  if (!uploadLimiter.tryAcquire()) {
    res.set('Retry-After', '5')
    res.status(429).send({ error: 'Too many concurrent uploads. Please try again later.' })
    return
  }

  let released = false
  let claimed: { release(): void } | undefined
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    claimed?.release()
    uploadLimiter.release()
  }

  const declaredBytes = parseContentLength(req.headers['content-length'])

  if (!checkRequestSize(declaredBytes, storage.maxRequestSizeBytes).allowed) {
    release()
    res.status(413).send({ error: 'Upload size limit exceeded' })
    return
  }

  availableStorageSize(blockstorePath)
    .then((available) => {
      // A chunked request declares no size, so the most it could write is what
      // its aggregate limit allows. Claiming that much keeps the reserve honest
      // for a request whose size is unknown, and claiming at all is what stops
      // several uploads from each seeing the same free space and passing.
      const claim = claimSpace({
        bytes: declaredBytes ?? storage.maxRequestSizeBytes,
        availableBytes: Number(available),
        reserveBytes: storage.diskReserveBytes
      })

      if (claim === undefined) {
        logger.warn(
          `Upload rejected: free space ${String(available)} bytes would fall into the ` +
            `${storage.diskReserveBytes} byte reserve`
        )
        release()
        res.status(507).send({ error: 'Insufficient storage' })
        return
      }

      const session = new UploadSession({
        blockstore: helia.blockstore,
        isPinned: (cid) => helia.pins.isPinned(cid),
        deleteBlock: (cid) => blockstore.delete(cid),
        maxRequestSizeBytes: storage.maxRequestSizeBytes,
        parseCid,
        onCleanupError: (err) => logger.error(`Upload cleanup error: ${err.message}`)
      })
      claimed = claim
      ;(req as RequestWithSession)[SESSION_KEY] = session

      // Covers every way a request can end without a durable result: a parser
      // abort, a route failure, or a client that disconnected mid-upload.
      res.on('close', () => {
        release()

        if (session.isSettled) {
          return
        }

        session
          .cleanup()
          .then((removed) => {
            if (removed > 0) {
              logger.info(`Removed ${removed} blocks left by an unfinished upload`)
            }
          })
          .catch((err) => logger.error(`Upload cleanup failed: ${(err as Error).message}`))
      })

      next()
    })
    .catch((err) => {
      release()
      next(err)
    })
}
