import { Router } from 'express'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { admitUpload, getUploadSession } from '../middleware/uploadGuards.js'
import { readLimiter, uploadLimiter } from '../middleware/rateLimiter.js'
import { multerStorage } from '../multer.js'
import { pinFile, unpinFile } from '../storage/pinning.js'
import {
  confirmFile,
  effectiveQuorum,
  prepareFileRetrieval,
  releaseFile,
  replicateFile
} from '../storage/service.js'
import type { FileRecord } from '../storage/registry.js'
import { rollbackUpload } from '../storage/rollback.js'
import { fileRegistry } from '../storage/state.js'
import { parseCid } from '../utils/cid.js'
import { sendDownloadStream } from '../utils/downloadResponse.js'
import { downloadFile, getFileStats } from '../utils/file.js'
import { logger } from '../utils/logger.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'

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
  async (req, res, next) => {
    if (!Array.isArray(req.files) || req.files.length === 0) {
      res.statusCode = 400
      return res.send({ error: 'No file uploaded' })
    }

    const session = getUploadSession(req)

    // A pin protects blocks from the session cleanup, and a registry entry
    // claims disk in the storage report. Both are created before the request is
    // known to succeed, so both have to be undone if it does not.
    const undo: Array<() => Promise<void>> = []

    try {
      const files = flatFiles(req.files as UnixFsMulterFile[])
      logger.info(`req.files: ${JSON.stringify(files.map((item) => item.originalname))}`)

      const records = []
      for (const file of files) {
        const cid = file.cid.toString()
        logger.info(`Successfully added file ${cid}`)

        // Only a pin this request created may be removed again; content that
        // was already durable keeps the pin it had.
        const createdPin = await pinFile(helia, file.cid)

        // What this request wrote, and what it replaced. Both are filled in
        // below, after the compensation that reads them is registered.
        //
        // The baseline cannot be read before the write: another upload of the
        // same file can adopt the CID in between, and restoring what this
        // request saw earlier would erase the lifecycle that upload owns. The
        // registration reports what it actually replaced, from inside the same
        // serialised section.
        const write: { record?: FileRecord; previous?: FileRecord } = {}

        // One compensation rather than two: the pin and the record have to be
        // undone under the same lock and in that order.
        undo.push(() =>
          rollbackUpload({
            registry: fileRegistry,
            cid,
            written: write.record,
            previous: write.previous,
            createdPin,
            unpin: async () => {
              await unpinFile(helia, file.cid)
            }
          })
        )

        const registration = await fileRegistry.registerReplacing(
          {
            cid,
            name: file.originalname,
            fileSize: file.size,
            storedBytes: file.storedBytes
          },
          {
            confirmationRequired: config.storage.confirmationRequired,
            temporaryTtlMs: config.storage.temporaryTtlMs
          }
        )

        write.record = registration.record
        write.previous = registration.previous

        records.push(registration.record)
      }

      // Every file is stored and pinned: the blocks written by this request must
      // now survive, so ownership passes from the session to the registry and
      // there is nothing left to undo.
      session.commit()
      undo.length = 0

      const durable = records.filter((record) => record.state === 'confirmed')
      const replication = await Promise.all(
        durable.map(async (record) => ({
          cid: record.cid,
          report: await replicateFile(record.cid)
        }))
      )
      const replicationByCid = new Map(replication.map((item) => [item.cid, item.report]))

      if (
        config.replication.requireQuorumOnUpload &&
        replication.some((item) => !item.report.satisfied)
      ) {
        // The policy demands a quorum, so the upload is not durable. The files are
        // released instead of being kept as a copy nobody promised to hold.
        await Promise.all(durable.map((record) => releaseFile(record.cid)))

        return res.status(503).send({ error: 'Replication quorum not reached' })
      }

      res.send({
        filesNames: files.map((file) => file.originalname),
        cids: records.map((record) => record.cid),
        files: records.map((record) => ({
          cid: record.cid,
          name: record.name,
          state: record.state,
          expiresAt: record.expiresAt,
          // Placement is decided per CID, so one file of a request can meet its
          // quorum while another does not, on different peers.
          replication: replicationByCid.get(record.cid) ?? null
        })),
        // The first file's report, kept for clients written against it. New
        // ones should read the per-file field above.
        replication: replication[0]?.report ?? null
      })
    } catch (err) {
      // Undo first, then let the response listener reclaim the blocks: cleanup
      // deliberately skips anything pinned, so a pin left behind here would
      // keep the failed upload on disk forever.
      for (const step of undo.reverse()) {
        try {
          await step()
        } catch (undoError) {
          logger.error(`Could not undo a failed upload: ${(undoError as Error).message}`)
        }
      }

      next(err)
    }
  }
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

router.get('/:cid', readLimiter, async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)

    // Reach the file's holders first. Without this the read only succeeds if a
    // peer that has the file is already connected, which stops being true as
    // soon as the network is larger than the connection limit.
    await prepareFileRetrieval(cid)

    const fileStats = await getFileStats(cid)
    const stream = downloadFile(cid)

    sendDownloadStream(
      stream,
      res,
      { cid: cid.toString(), fileSize: fileStats.size },
      next,
      (error) => logger.error(error)
    )
  } catch (error) {
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

    res.send({
      cid: cid.toString(),
      state: record?.state ?? 'expired',
      pinned: false,
      reclaimable: true
    })
  } catch (err) {
    next(err)
  }
})

export default router
