import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'
import { getStorageMetrics } from '../storage/metrics.js'
import { getHealthSnapshot } from '../health/service.js'
import { getHttpMetrics } from '../observability.js'
import { readLimiter } from '../middleware/rateLimiter.js'
import { createNodeRouters } from './nodeRoutes.js'

const routers = createNodeRouters({
  version: packageJson.version,
  now: Date.now,
  uptimeMs: () => Math.floor(process.uptime() * 1000),
  readLimiter,
  getHeliaStatus: () => helia.libp2p.status,
  getPeerId: () => helia.libp2p.peerId.toString(),
  getMultiAddresses: () => helia.libp2p.getMultiaddrs().map((address) => address.toString()),
  getDiskUsageStats,
  getStorageMetrics,
  getHealthSnapshot,
  getHttpMetrics
})

export const publicNodeRouter = routers.publicNodeRouter
export default routers.nodeRouter
