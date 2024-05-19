import { Router } from 'express'
import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'

const router = Router()

router.get('/node/health', async (req, res) => {
  res.send({
    timestamp: Date.now(),
    heliaStatus: helia.libp2p.status
  })
})

router.get('/node/info', async (req, res) => {
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
})

export default router
