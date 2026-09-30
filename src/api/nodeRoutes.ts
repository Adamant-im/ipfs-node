import { Router, type RequestHandler } from 'express'
import type { HealthSnapshot } from '../health/state.js'

/** Runtime values used by the testable node HTTP contract. */
export interface NodeRouteDependencies {
  version: string
  now: () => number
  uptimeMs: () => number
  readLimiter: RequestHandler
  getHeliaStatus: () => string
  getPeerId: () => string
  getMultiAddresses: () => string[]
  getDiskUsageStats: () => {
    blockstoreSizeMb: number
    datastoreSizeMb: number
    availableSizeInMb: number
  }
  getStorageMetrics: () => {
    pinnedBytes: number
    reclaimableBytes: number
    availableBytes: number
    reservedBytes: number
  }
  getHealthSnapshot: () => HealthSnapshot
  getHttpMetrics: () => unknown
  /** Admission-limiter occupancy; operator-only, like the byte-accurate figures. */
  getConcurrencyMetrics: () => unknown
}

/** Build public and administrative node routers from explicit runtime dependencies. */
export function createNodeRouters(deps: NodeRouteDependencies): {
  publicNodeRouter: Router
  nodeRouter: Router
} {
  const publicNodeRouter = Router()
  const nodeRouter = Router()

  publicNodeRouter.get('/health', (_req, res, next) => {
    try {
      res.status(200).send({
        version: deps.version,
        uptimeMs: deps.uptimeMs(),
        ...deps.getHealthSnapshot()
      })
    } catch (err) {
      next(err)
    }
  })

  /** Legacy PWA/iOS contract. Keep public and free of node identity or operator data. */
  publicNodeRouter.get('/info', deps.readLimiter, (_req, res, next) => {
    try {
      res.send({
        version: deps.version,
        timestamp: deps.now(),
        heliaStatus: deps.getHeliaStatus(),
        ...deps.getDiskUsageStats()
      })
    } catch (err) {
      next(err)
    }
  })

  /** Detailed node identity and storage report for authenticated operators. */
  nodeRouter.get('/details', (_req, res, next) => {
    try {
      const storage = deps.getStorageMetrics()
      res.send({
        version: deps.version,
        timestamp: deps.now(),
        heliaStatus: deps.getHeliaStatus(),
        peerId: deps.getPeerId(),
        multiAddresses: deps.getMultiAddresses(),
        ...deps.getDiskUsageStats(),
        // Byte-accurate figures; GET /api/storage/metrics carries the full report.
        pinnedBytes: storage.pinnedBytes,
        reclaimableBytes: storage.reclaimableBytes,
        availableBytes: storage.availableBytes,
        reservedBytes: storage.reservedBytes,
        health: {
          // Keep the complete public Health schema so the OpenAPI $ref remains exact.
          version: deps.version,
          uptimeMs: deps.uptimeMs(),
          ...deps.getHealthSnapshot()
        },
        http: deps.getHttpMetrics(),
        concurrency: deps.getConcurrencyMetrics()
      })
    } catch (err) {
      next(err)
    }
  })

  return { publicNodeRouter, nodeRouter }
}
