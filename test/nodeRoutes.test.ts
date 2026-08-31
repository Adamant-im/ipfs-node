import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import express, { Router, type Express } from 'express'
import { createNodeRouters } from '../src/api/nodeRoutes.js'
import { mountApiRoutes } from '../src/security/accessPolicy.js'
import { createApiKeyAuth } from '../src/security/apiKey.js'
import { refreshHealthSnapshot } from '../src/health/state.js'
import type { HealthSnapshot } from '../src/health/state.js'

const health: HealthSnapshot = {
  state: 'ready',
  height: 12_000,
  timestamp: 12_345,
  checkpoint: { intervalMs: 1_000, observedAt: 12_345, ageMs: 0, maxAgeMs: 3_000 },
  membership: { version: 'a'.repeat(64), requiredPeers: 1, attestedPeers: 1 },
  startup: { complete: true, healthy: true },
  storage: { measuredAt: 12_345, measurementAgeMs: 0, reserveHealthy: true },
  replication: { repairRequired: true, lastCompleteAt: 12_345, ageMs: 0, backlog: 0 },
  checks: {
    checkpointFresh: true,
    helia: true,
    startupReconciliation: true,
    storageFresh: true,
    storageReserve: true,
    repairFresh: true,
    peerAttestations: true
  }
}

describe('node HTTP contract', () => {
  let url = ''
  let close: (() => Promise<void>) | undefined
  let limited = 0
  let healthNow = 12_345

  before(async () => {
    const routers = createNodeRouters({
      version: '1.2.3',
      now: () => 20_000,
      uptimeMs: () => 5_000,
      readLimiter: (_req, _res, next) => {
        limited += 1
        next()
      },
      getHeliaStatus: () => 'started',
      getPeerId: () => 'peer-id',
      getMultiAddresses: () => ['/ip4/127.0.0.1/tcp/4001'],
      getDiskUsageStats: () => ({
        blockstoreSizeMb: 1,
        datastoreSizeMb: 2,
        availableSizeInMb: 3
      }),
      getStorageMetrics: () => ({
        pinnedBytes: 4,
        reclaimableBytes: 5,
        availableBytes: 6,
        reservedBytes: 7
      }),
      getHealthSnapshot: () =>
        refreshHealthSnapshot(health, healthNow, {
          storageMaxAgeMs: 2_000,
          repairMaxAgeMs: 5_000
        }),
      getHttpMetrics: () => ({ requests: 1 }),
      getConcurrencyMetrics: () => ({
        uploads: { active: 1, limit: 32 },
        incomingCopies: { active: 0, limit: 8 },
        downloads: { active: 2, limit: 64, perClientLimit: 8 }
      })
    })
    const app = express()
    app.use('/api/node', routers.publicNodeRouter)
    app.use('/api/node', routers.nodeRouter)
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    const address = server.address() as AddressInfo
    url = `http://127.0.0.1:${address.port}`
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  })

  after(async () => close?.())

  it('serves the always-200 health schema without a rate-limit status override', async () => {
    const response = await fetch(`${url}/api/node/health`)
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.version, '1.2.3')
    assert.equal(body.state, 'ready')
    assert.equal(body.height, 12_000)
    assert.equal('peerId' in body, false)
    assert.equal('multiAddresses' in body, false)
    assert.equal('http' in body, false)
    assert.equal(limited, 0)
  })

  it('downgrades the cached response to stale on an HTTP read', async () => {
    healthNow = 16_000
    const response = await fetch(`${url}/api/node/health`)
    const body = (await response.json()) as { state: string; checkpoint: { ageMs: number } }

    assert.equal(response.status, 200)
    assert.equal(body.state, 'stale')
    assert.equal(body.checkpoint.ageMs, 3_655)
  })

  it('rate-limits the legacy public info route', async () => {
    assert.equal((await fetch(`${url}/api/node/info`)).status, 200)
    assert.equal(limited, 1)
  })

  it('serializes the operator identity and embeds the complete health schema', async () => {
    const response = await fetch(`${url}/api/node/details`)
    const body = (await response.json()) as {
      peerId: string
      multiAddresses: string[]
      health: { version: string; uptimeMs: number }
    }

    assert.equal(body.peerId, 'peer-id')
    assert.deepEqual(body.multiAddresses, ['/ip4/127.0.0.1/tcp/4001'])
    assert.equal(body.health.version, '1.2.3')
    assert.equal(body.health.uptimeMs, 5_000)
  })

  it('reports admission-limiter occupancy so a capacity 429 is attributable', async () => {
    const body = (await (await fetch(`${url}/api/node/details`)).json()) as {
      concurrency: { downloads: { active: number; limit: number; perClientLimit: number } }
    }

    assert.deepEqual(body.concurrency.downloads, { active: 2, limit: 64, perClientLimit: 8 })
  })
})

/**
 * The router-level suite above mounts `/details` without the admin boundary.
 * This one wires the real routers through `mountApiRoutes` and the real
 * key middleware, so the payload and the boundary are asserted together.
 */
describe('node routes behind the mounted access policy', () => {
  const key = 'c'.repeat(64)
  let url = ''
  let close: (() => Promise<void>) | undefined

  before(async () => {
    const routers = createNodeRouters({
      version: '1.2.3',
      now: () => 20_000,
      uptimeMs: () => 5_000,
      readLimiter: (_req, _res, next) => next(),
      getHeliaStatus: () => 'started',
      getPeerId: () => 'peer-id',
      getMultiAddresses: () => ['/ip4/127.0.0.1/tcp/4001'],
      getDiskUsageStats: () => ({
        blockstoreSizeMb: 1,
        datastoreSizeMb: 2,
        availableSizeInMb: 3
      }),
      getStorageMetrics: () => ({
        pinnedBytes: 4,
        reclaimableBytes: 5,
        availableBytes: 6,
        reservedBytes: 7
      }),
      getHealthSnapshot: () => health,
      getHttpMetrics: () => ({ requests: 1 }),
      getConcurrencyMetrics: () => ({
        uploads: { active: 1, limit: 32 },
        incomingCopies: { active: 0, limit: 8 },
        downloads: { active: 2, limit: 64, perClientLimit: 8 }
      })
    })
    const app = express()
    const empty = (): Router => Router()

    mountApiRoutes(
      app,
      {
        file: empty(),
        fileAdminRouter: empty(),
        publicNodeRouter: routers.publicNodeRouter,
        node: routers.nodeRouter,
        helia: empty(),
        libp2p: empty(),
        debug: empty(),
        storage: empty(),
        storageAdminRouter: empty()
      },
      createApiKeyAuth(key),
      false
    )

    const server = await startServer(app)
    url = server.url
    close = server.close
  })

  after(async () => close?.())

  it('serves the public routes without a key', async () => {
    assert.equal((await fetch(`${url}/api/node/health`)).status, 200)
    assert.equal((await fetch(`${url}/api/node/info`)).status, 200)
  })

  it('serves the complete operator payload only with a matching key', async () => {
    assert.equal((await fetch(`${url}/api/node/details`)).status, 401)

    const response = await fetch(`${url}/api/node/details`, { headers: { 'x-api-key': key } })
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    for (const field of [
      'version',
      'timestamp',
      'heliaStatus',
      'peerId',
      'multiAddresses',
      'blockstoreSizeMb',
      'datastoreSizeMb',
      'availableSizeInMb',
      'pinnedBytes',
      'reclaimableBytes',
      'availableBytes',
      'reservedBytes',
      'health',
      'http',
      'concurrency'
    ]) {
      assert.ok(field in body, `missing ${field}`)
    }
  })
})

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<Express['listen']>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
