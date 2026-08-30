import { Router } from 'express'
import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'
import { getStorageMetrics } from '../storage/metrics.js'
import { getHealthSnapshot } from '../health/service.js'
import { getHttpMetrics } from '../observability.js'

export const publicNodeRouter = Router()
const router = Router()

publicNodeRouter.get('/health', async (req, res, next) => {
  try {
    res.status(200).send(getHealthSnapshot())
  } catch (err) {
    next(err)
  }
})

/** Legacy PWA/iOS contract. Keep public and free of node identity or operator data. */
publicNodeRouter.get('/info', async (req, res, next) => {
  try {
    const { blockstoreSizeMb, datastoreSizeMb, availableSizeInMb } = getDiskUsageStats()
    res.send({
      version: packageJson.version,
      timestamp: Date.now(),
      heliaStatus: helia.libp2p.status,
      blockstoreSizeMb,
      datastoreSizeMb,
      availableSizeInMb
    })
  } catch (err) {
    next(err)
  }
})

/** Detailed node identity and storage report for authenticated operators. */
router.get('/details', async (req, res, next) => {
  try {
    const { blockstoreSizeMb, datastoreSizeMb, availableSizeInMb } = getDiskUsageStats()
    const storage = getStorageMetrics()
    res.send({
      version: packageJson.version,
      timestamp: Date.now(),
      heliaStatus: helia.libp2p.status,
      peerId: helia.libp2p.peerId,
      multiAddresses: helia.libp2p.getMultiaddrs(),
      blockstoreSizeMb,
      datastoreSizeMb,
      availableSizeInMb,
      // Byte-accurate figures; GET /api/storage/metrics carries the full report.
      pinnedBytes: storage.pinnedBytes,
      reclaimableBytes: storage.reclaimableBytes,
      availableBytes: storage.availableBytes,
      reservedBytes: storage.reservedBytes,
      health: getHealthSnapshot(),
      http: getHttpMetrics()
    })
  } catch (err) {
    next(err)
  }
})

export default router
