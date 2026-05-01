import { Router } from 'express'
import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'

const router = Router()

router.get('/health', async (req, res, next) => {
  try {
    res.send({
      timestamp: Date.now(),
      heliaStatus: helia.libp2p.status
    })
  } catch (err) {
    next(err)
  }
})

// Protected — full node topology for operators only
// Requires x-api-key header matching config.adminApiKey
router.get('/info', apiKeyAuth, async (req, res, next) => {
  try {
    const { blockstoreSizeMb, datastoreSizeMb, availableSizeInMb } = getDiskUsageStats()
    res.send({
      version: packageJson.version,
      timestamp: Date.now(),
      heliaStatus: helia.libp2p.status,
      peerId: helia.libp2p.peerId,
      multiAddresses: helia.libp2p.getMultiaddrs(),
      blockstoreSizeMb,
      datastoreSizeMb,
      availableSizeInMb
    })
  } catch (err) {
    next(err)
  }
})

export default router
