import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { createNodeRouters } from '../src/api/nodeRoutes.js'
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
      getHttpMetrics: () => ({ requests: 1 })
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
})
