import { Router } from 'express'
import { config } from '../config.js'
import {
  collectGarbage,
  GarbageCollectionBusyError,
  getGarbageCollectionState
} from '../gc.cron.js'
import { readLimiter } from '../middleware/rateLimiter.js'
import {
  getReplicationState,
  repairUnderReplicatedFiles,
  ReplicationRepairBusyError
} from '../replication.cron.js'
import { getStorageMetrics } from '../storage/metrics.js'

const router = Router()

/** Routes that reclaim storage or move copies; mounted behind the admin key. */
export const storageAdminRouter = Router()

/**
 * Storage report: pinned, reclaimable, available and reserved bytes, plus the
 * lifecycle counters and the state of the background jobs.
 *
 * Values come from the disk usage schedule, so they are as fresh as
 * `diskUsageScanPeriod`.
 */
router.get('/metrics', readLimiter, (req, res) => {
  res.send({
    timestamp: Date.now(),
    storage: getStorageMetrics(),
    gc: getGarbageCollectionState(),
    replication: getReplicationState()
  })
})

/** Limits and lifecycle rules a client needs before uploading. */
router.get('/policy', readLimiter, (req, res) => {
  res.send({
    maxFileCount: config.maxFileCount,
    uploadLimitSizeBytes: config.uploadLimitSizeBytes,
    maxRequestSizeBytes: config.storage.maxRequestSizeBytes,
    maxConcurrentUploads: config.storage.maxConcurrentUploads,
    confirmationRequired: config.storage.confirmationRequired,
    temporaryTtlMs: config.storage.temporaryTtlMs,
    durability: config.replication.enabled
      ? {
          mode: 'quorum',
          // Copies are reduced as a file ages; the tiers are the whole policy.
          placement: config.replication.placement,
          ackQuorum: config.replication.ackQuorum
        }
      : { mode: 'best-effort', placement: [{ minAgeMs: 0, copies: 1 }], ackQuorum: 1 }
  })
})

/**
 * Run garbage collection on demand.
 *
 * `?dryRun=true` reports the files that would be released and the files that
 * would be retained without touching a single block, which is the supported way
 * to review a deletion policy before enabling the scheduled collector.
 *
 * `?force=true` collects even when the blockstore is below the high watermark.
 */
storageAdminRouter.post('/gc', async (req, res, next) => {
  try {
    const report = await collectGarbage({
      dryRun: req.query.dryRun === 'true',
      force: req.query.force === 'true'
    })

    // The response is built field by field rather than forwarded, so the
    // payload stays a deliberate contract and carries nothing derived from the
    // request beyond the two flags above.
    res.send({
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      dryRun: report.dryRun,
      collected: report.collected,
      blockstoreBytesBefore: report.blockstoreBytesBefore,
      estimatedBytesAfter: report.estimatedBytesAfter,
      releasedCids: report.releasedCids,
      retainedCids: report.retainedCids,
      demoted: report.demoted,
      removedBlocks: report.removedBlocks,
      removedCids: report.removedCids,
      repairedPins: report.repairedPins,
      errors: report.errors
    })
  } catch (err) {
    if (err instanceof GarbageCollectionBusyError) {
      return res.status(409).send({ error: 'Garbage collection is already running' })
    }
    next(err)
  }
})

/** Detect and repair under-replicated durable content on demand. */
storageAdminRouter.post('/repair', async (req, res, next) => {
  try {
    res.send(await repairUnderReplicatedFiles())
  } catch (err) {
    if (err instanceof ReplicationRepairBusyError) {
      return res.status(409).send({ error: 'Replication repair is already running' })
    }
    next(err)
  }
})

export default router
