import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HealthConfig } from '../src/config.js'
import { isCompatibleRound } from '../src/health/protocol.js'
import { checkpointRound, evaluateHealth, refreshHealthSnapshot } from '../src/health/state.js'

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
  repairHealthy: true,
  repairBacklog: 0,
  attestedPeers: 1,
  membershipVersion: 'a'.repeat(64),
  previous: null
})

describe('health checkpoint state', () => {
  it('accepts adjacent fixed rounds during tolerated boundary skew', () => {
    assert.equal(isCompatibleRound(12_000, 13_000, 1_000), true)
    assert.equal(isCompatibleRound(12_000, 14_000, 1_000), false)
  })

  it('uses a fixed Unix-millisecond round rather than the request timestamp', () => {
    assert.equal(checkpointRound(12_345, 1_000), 12_000)
    const result = evaluateHealth(policy, healthy(12_345))

    assert.equal(result.snapshot.state, 'ready')
    assert.equal(result.snapshot.height, 12_000)
    assert.equal(result.snapshot.timestamp, 12_345)
    assert.equal(result.snapshot.checkpoint.observedAt, 12_345)
    assert.equal(result.snapshot.storage.measurementAgeMs, 0)
    assert.equal(result.snapshot.storage.reserveHealthy, true)
    assert.equal(result.snapshot.replication.backlog, 0)
  })

  it('freezes height when peer coverage is lost', () => {
    const prior = evaluateHealth(policy, healthy(12_345)).completed!
    const result = evaluateHealth(policy, {
      ...healthy(13_456),
      attestedPeers: 0,
      previous: prior
    })

    assert.equal(result.snapshot.state, 'degraded')
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

    assert.equal(result.snapshot.state, 'stale')
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

    assert.equal(starting.snapshot.state, 'starting')
    assert.equal(failed.snapshot.state, 'degraded')
  })

  it('does not advance while a known repair backlog remains', () => {
    const result = evaluateHealth(policy, {
      ...healthy(12_345),
      repairBacklog: 1
    })

    assert.equal(result.snapshot.state, 'degraded')
    assert.equal(result.snapshot.checks.repairFresh, false)
    assert.equal(result.completed, undefined)
  })

  it('reports a cached ready checkpoint as stale when its age expires', () => {
    const ready = evaluateHealth(policy, healthy(12_345)).snapshot
    const refreshed = refreshHealthSnapshot(ready, 16_000, policy)

    assert.equal(refreshed.state, 'stale')
    assert.equal(refreshed.checks.checkpointFresh, false)
    assert.equal(refreshed.checkpoint.ageMs, 3_655)
    assert.equal(refreshed.height, ready.height)
  })

  it('expires cached storage and repair checks before the next checkpoint tick', () => {
    const ready = evaluateHealth(policy, healthy(12_345)).snapshot
    const storageExpired = refreshHealthSnapshot(ready, 14_500, policy)
    const repairExpired = refreshHealthSnapshot(ready, 17_500, policy)

    assert.equal(storageExpired.state, 'degraded')
    assert.equal(storageExpired.checks.storageFresh, false)
    assert.equal(storageExpired.checks.repairFresh, true)
    assert.equal(repairExpired.state, 'stale')
    assert.equal(repairExpired.checks.repairFresh, false)
  })

  it('dates non-checkpoint evidence by the attempt, not by the last success', () => {
    const prior = evaluateHealth(policy, healthy(12_345)).completed!
    const failed = evaluateHealth(policy, {
      ...healthy(13_000),
      attestedPeers: 0,
      previous: prior
    }).snapshot

    // The attempt at 13_000 produced membership and checks; observedAt still
    // points at the successful round, so the two must not share a timestamp.
    assert.equal(failed.evaluatedAt, 13_000)
    assert.equal(failed.checkpoint.observedAt, 12_345)
    assert.equal(failed.membership.attestedPeers, 0)

    // A read moves `timestamp` but must not move the evaluation time with it.
    const read = refreshHealthSnapshot(failed, 13_500, policy)
    assert.equal(read.timestamp, 13_500)
    assert.equal(read.evaluatedAt, 13_000)
  })

  it('keeps the maximum checkpoint age inclusive', () => {
    const ready = evaluateHealth(policy, healthy(12_345)).snapshot
    const boundary = refreshHealthSnapshot(ready, 15_345, policy)

    assert.notEqual(boundary.state, 'stale')
    assert.equal(boundary.checkpoint.ageMs, boundary.checkpoint.maxAgeMs)
  })
})
