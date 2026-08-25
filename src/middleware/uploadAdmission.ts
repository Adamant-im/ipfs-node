import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Blockstore } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'
import { checkRequestSize, parseContentLength } from '../storage/limits.js'
import type { StorageOperationLease, StorageOperationLock } from '../storage/operationLock.js'
import { claimSpace } from '../storage/reservation.js'
import type { StorageConfig } from '../storage/config.js'
import { UploadSession } from '../storage/uploadSession.js'

const SESSION_KEY = Symbol('uploadSession')

type RequestWithSession = Request & { [SESSION_KEY]?: UploadSession }

interface UploadConcurrencyLimiter {
  tryAcquire(): boolean
  release(): void
}

interface UploadAdmissionLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface UploadAdmissionDependencies {
  storage: Pick<StorageConfig, 'maxRequestSizeBytes' | 'diskReserveBytes'>
  limiter: UploadConcurrencyLimiter
  operationLock: Pick<StorageOperationLock, 'acquireShared'>
  availableStorageSize: () => Promise<bigint>
  blockstore: Blockstore
  isPinned: (cid: CID) => Promise<boolean>
  deleteBlock: (cid: CID) => Promise<void>
  parseCid: (cid: string) => CID
  log: UploadAdmissionLog
}

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
 * Build admission control for uploads from explicit storage dependencies.
 *
 * Runs before the multipart parser so a request that cannot be stored is
 * refused before any block reaches the blockstore. The returned middleware
 * holds a shared storage-operation lease through pin/commit or cleanup, which
 * keeps destructive GC outside the import-to-pin window.
 */
export function createUploadAdmission(dependencies: UploadAdmissionDependencies): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { storage } = dependencies

    if (!dependencies.limiter.tryAcquire()) {
      res.set('Retry-After', '5')
      res.status(429).send({ error: 'Too many concurrent uploads. Please try again later.' })
      return
    }

    let released = false
    let claimed: { release(): void } | undefined
    let session: UploadSession | undefined
    let operationLease: StorageOperationLease | undefined
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      claimed?.release()
      dependencies.limiter.release()

      // An admitted session owns this lease until it has committed or finished
      // cleanup. Releasing it on `close` before cleanup would reopen the exact
      // window in which GC can delete the session's unpinned blocks.
      if (session === undefined || session.isSettled) {
        operationLease?.release()
      }
    }

    // Attached before anything is awaited, and it covers every way a request can
    // end without a durable result: a parser abort, a route failure, or a client
    // that disconnected mid-upload.
    //
    // A client that hangs up while free space is being measured fires `close`
    // inside that window. A listener added afterwards would never run, and the
    // upload slot and the space claim would stay taken until the process
    // restarts — which anyone could trigger, repeatedly, just by disconnecting.
    res.on('close', () => {
      release()

      if (session === undefined || session.isSettled) {
        return
      }

      session
        .cleanup()
        .then((removed) => {
          if (removed > 0) {
            dependencies.log.info(`Removed ${removed} blocks left by an unfinished upload`)
          }
        })
        .catch((err) => dependencies.log.error(`Upload cleanup failed: ${(err as Error).message}`))
    })

    const declaredBytes = parseContentLength(req.headers['content-length'])

    if (!checkRequestSize(declaredBytes, storage.maxRequestSizeBytes).allowed) {
      release()
      res.status(413).send({ error: 'Upload size limit exceeded' })
      return
    }

    void (async () => {
      operationLease = await dependencies.operationLock.acquireShared()

      if (released) {
        operationLease.release()
        return
      }

      const available = await dependencies.availableStorageSize()

      // The client is already gone and the slot went back with it. Claiming
      // space now would promise it to a request that no longer exists.
      if (released) {
        operationLease.release()
        return
      }

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
        dependencies.log.warn(
          `Upload rejected: free space ${String(available)} bytes would fall into the ` +
            `${storage.diskReserveBytes} byte reserve`
        )
        release()
        res.status(507).send({ error: 'Insufficient storage' })
        return
      }

      session = new UploadSession({
        blockstore: dependencies.blockstore,
        isPinned: dependencies.isPinned,
        deleteBlock: dependencies.deleteBlock,
        maxRequestSizeBytes: storage.maxRequestSizeBytes,
        parseCid: dependencies.parseCid,
        onCleanupError: (err) => dependencies.log.error(`Upload cleanup error: ${err.message}`),
        onSettle: () => operationLease?.release()
      })
      claimed = claim
      ;(req as RequestWithSession)[SESSION_KEY] = session

      next()
    })().catch((err) => {
      release()
      next(err)
    })
  }
}
