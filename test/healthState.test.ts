import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HealthConfig } from '../src/config.js'
import { checkpointRound, evaluateHealth } from '../src/health/state.js'

const policy: HealthConfig = {
  checkpointIntervalMs: 1_000,
  maxCheckpointAgeMs: 3_000,
  storageMaxAgeMs: 2_000,
  repairMaxAgeMs: 5_000,
  clockSkewToleranceMs: 100,
  peerAttestationTimeoutMs: 100,
  requiredPeerCount: 1
}

const healthy = (now: number) => ({
  now,
  heliaReady: true,
  startupComplete: true,
  startupHealthy: true,
  storageUpdatedAt: now,
  storageAvailableBytes: 2_000,
  storageReservedBytes: 1_000,
  repairRequired: true,
  repairCompletedAt: now,
  attestedPeers: 1,
  membershipVersion: 'a'.repeat(64),
  previous: null
})

describe('health checkpoint state', () => {
  it('uses a fixed Unix-millisecond round rather than the request timestamp', () => {
    assert.equal(checkpointRound(12_345, 1_000), 12_000)
    const result = evaluateHealth(policy, healthy(12_345))

    assert.equal(result.snapshot.status, 'ready')
    assert.equal(result.snapshot.height, 12_000)
    assert.equal(result.snapshot.timestamp, 12_345)
  })

  it('freezes height when peer coverage is lost', () => {
    const prior = evaluateHealth(policy, healthy(12_345)).completed!
    const result = evaluateHealth(policy, {
      ...healthy(13_456),
      attestedPeers: 0,
      previous: prior
    })

    assert.equal(result.snapshot.status, 'degraded')
    assert.equal(result.snapshot.height, 12_000)
    assert.equal(result.completed, undefined)
  })

  it('reports stale after the last valid checkpoint exceeds its age bound', () => {
    const prior = evaluateHealth(policy, healthy(12_345)).completed!
    const result = evaluateHealth(policy, {
      ...healthy(16_000),
      storageUpdatedAt: 12_345,
      previous: prior
    })

    assert.equal(result.snapshot.status, 'stale')
    assert.equal(result.snapshot.height, prior.height)
  })

  it('distinguishes incomplete startup from a failed reconciliation', () => {
    const starting = evaluateHealth(policy, {
      ...healthy(12_345),
      startupComplete: false,
      startupHealthy: false
    })
    const failed = evaluateHealth(policy, {
      ...healthy(12_345),
      startupHealthy: false
    })

    assert.equal(starting.snapshot.status, 'starting')
    assert.equal(failed.snapshot.status, 'degraded')
  })
})
