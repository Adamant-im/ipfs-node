import { Router } from 'express'
import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'
import { getStorageMetrics } from '../storage/metrics.js'

export const publicNodeRouter = Router()
const router = Router()

publicNodeRouter.get('/health', async (req, res, next) => {
  try {
    res.send({
      timestamp: Date.now(),
      heliaStatus: helia.libp2p.status
    })
  } catch (err) {
    next(err)
  }
})

router.get('/info', async (req, res, next) => {
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
      reservedBytes: storage.reservedBytes
    })
  } catch (err) {
    next(err)
  }
})

export default router
