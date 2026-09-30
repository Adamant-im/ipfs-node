import { Router } from 'express'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { admitUpload, getUploadSession } from '../middleware/uploadGuards.js'
import { readLimiter, uploadLimiter } from '../middleware/rateLimiter.js'
import { admitDownload } from '../middleware/downloadGuards.js'
import { multerStorage } from '../multer.js'
import {
  abortUploadedReplicas,
  commitUploadedReplicas,
  confirmFile,
  effectiveQuorum,
  prepareFileRetrieval,
  releaseFile,
  replicateUploadedFile
} from '../storage/service.js'
import { fileRegistry } from '../storage/state.js'
import { createUploadHandler } from './uploadRoute.js'
import { parseCid } from '../utils/cid.js'
import {
  matchesDownloadEtag,
  sendDownloadStream,
  setDownloadHeaders
} from '../utils/downloadResponse.js'
import { downloadFile, getFileStats } from '../utils/file.js'
import { logger } from '../utils/logger.js'

const router = Router()

/** Routes that make content durable or reclaim it; mounted behind the admin key. */
export const fileAdminRouter = Router()

/**
 * Accept files into the blockstore.
 *
 * `admitUpload` refuses the request before any block is written when the node
 * is at its concurrency limit, when the aggregate request size is too large, or
 * when storing the request would eat into the disk reserve. The multipart
 * parser enforces the file count and the per-file size, so an over-limit part
 * never reaches the blockstore either.
 *
 * Files become durable immediately unless `storage.confirmationRequired` is
 * enabled, in which case they stay temporary until an authorized confirmation.
 */
router.post(
  '/upload',
  uploadLimiter,
  admitUpload,
  multerStorage.array('files'),
  createUploadHandler({
    node: helia,
    registry: fileRegistry,
    getSession: getUploadSession,
    confirmationRequired: config.storage.confirmationRequired,
    temporaryTtlMs: config.storage.temporaryTtlMs,
    requireQuorumOnUpload: config.replication.requireQuorumOnUpload,
    replicate: replicateUploadedFile,
    commitReplicas: commitUploadedReplicas,
    abortReplicas: abortUploadedReplicas,
    log: logger
  })
)

/**
 * Lifecycle state of a file.
 *
 * Deliberately free of the original filename so that the endpoint stays safe to
 * expose next to the public download route.
 */
router.get('/:cid/status', readLimiter, async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)
    const record = await fileRegistry.get(cid.toString())

    if (!record) {
      return res.status(404).send({ error: 'Unknown CID' })
    }

    res.send({
      cid: record.cid,
      state: record.state,
      pinned: record.pinned,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      confirmedAt: record.confirmedAt,
      replication: {
        // A file handed over to other nodes keeps its record but no longer
        // counts here, so the local copy is only added while it is still held.
        acknowledged: record.replicas.length + (record.heldLocally ? 1 : 0),
        // What this file is actually held to, not what the configuration asks
        // for in the abstract: a quorum larger than the network can answer is
        // capped when the file is placed, and reporting the raw number would
        // show every file as short of it forever.
        required: effectiveQuorum(record.cid, record.createdAt),
        heldLocally: record.heldLocally
      }
    })
  } catch (err) {
    next(err)
  }
})

router.get('/:cid', readLimiter, admitDownload, async (req, res, next) => {
  const requestController = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) {
      requestController.abort(new Error('Download client disconnected'))
    }
  })

  try {
    const cid = parseCid(req.params.cid)

    // Reach the file's holders first. Without this the read only succeeds if a
    // peer that has the file is already connected, which stops being true as
    // soon as the network is larger than the connection limit.
    await prepareFileRetrieval(cid, requestController.signal)

    const fileStats = await getFileStats(cid, requestController.signal)
    const metadata = { cid: cid.toString(), fileSize: fileStats.size }

    // Range is deliberately ignored and the complete representation is sent.
    // This preserves established PWA/iOS behavior without advertising ranges.
    if (matchesDownloadEtag(req.headers['if-none-match'], metadata.cid)) {
      setDownloadHeaders(res, metadata)
      res.removeHeader('Content-Length')
      res.removeHeader('Content-Disposition')
      return res.status(304).end()
    }

    const download = downloadFile(cid, fileStats.size, { signal: requestController.signal })

    sendDownloadStream(
      download.stream,
      res,
      metadata,
      next,
      (error) => logger.error(error),
      () => download.abort(new Error('Download client disconnected'))
    )
  } catch (error) {
    if (requestController.signal.aborted || res.destroyed) return
    next(error)
  }
})

/** Promote a temporary upload to durable storage. */
fileAdminRouter.post('/:cid/confirm', async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)
    const record = await confirmFile(cid.toString())

    if (!record) {
      return res.status(404).send({ error: 'Unknown CID' })
    }

    res.send({ cid: record.cid, state: record.state, replicas: record.replicas })
  } catch (err) {
    next(err)
  }
})

/**
 * Release durable content.
 * The blocks are reclaimed by the next garbage collection, not by this call.
 */
fileAdminRouter.post('/:cid/unpin', async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)
    const record = await releaseFile(cid.toString())

    // Nothing was released, so saying so would be a lie an operator acts on.
    if (!record) {
      return res.status(404).send({ error: 'Unknown CID' })
    }

    res.send({
      cid: cid.toString(),
      state: record.state,
      pinned: false,
      reclaimable: true
    })
  } catch (err) {
    next(err)
  }
})

export default router
