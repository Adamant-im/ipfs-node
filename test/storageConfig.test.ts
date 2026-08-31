import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_REPLICATION_CONFIG,
  DEFAULT_STORAGE_CONFIG,
  resolveReplicationConfig,
  resolveStorageConfig
} from '../src/storage/config.js'

const UPLOAD_LIMIT = 1024

describe('resolveStorageConfig', () => {
  it('applies every default when the section is absent', () => {
    assert.deepEqual(resolveStorageConfig(undefined, UPLOAD_LIMIT), DEFAULT_STORAGE_CONFIG)
  })

  it('keeps operator values and fills in the rest', () => {
    const storage = resolveStorageConfig(
      { diskReserveBytes: 1, gc: { enabled: true } },
      UPLOAD_LIMIT
    )

    assert.equal(storage.diskReserveBytes, 1)
    assert.equal(storage.gc.enabled, true)
    assert.equal(storage.gc.schedule, DEFAULT_STORAGE_CONFIG.gc.schedule)
    assert.equal(storage.temporaryTtlMs, DEFAULT_STORAGE_CONFIG.temporaryTtlMs)
  })

  it('rejects a low watermark the collector could never reach', () => {
    assert.throws(
      () =>
        resolveStorageConfig(
          { gc: { highWatermarkBytes: 100, lowWatermarkBytes: 100 } },
          UPLOAD_LIMIT
        ),
      /lowWatermarkBytes/
    )
  })

  it('rejects an aggregate limit smaller than the per-file limit', () => {
    assert.throws(
      () => resolveStorageConfig({ maxRequestSizeBytes: 512 }, UPLOAD_LIMIT),
      /maxRequestSizeBytes/
    )
  })

  it('rejects limits that would disable a guarantee', () => {
    assert.throws(() => resolveStorageConfig({ maxConcurrentUploads: 0 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ maxConcurrentDownloads: 0 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ temporaryTtlMs: 0 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ diskReserveBytes: -1 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ confirmationRequired: 'yes' }, UPLOAD_LIMIT))
  })

  it('admits enough concurrent uploads for several clients at once', () => {
    // Several clients uploading to one node at the same time is ordinary
    // traffic. A limit low enough to be reached by it answers 429 to a person
    // who did nothing wrong, and disk is bounded by the space claim anyway.
    assert.ok(
      DEFAULT_STORAGE_CONFIG.maxConcurrentUploads >= 16,
      'the default must not turn normal simultaneous use into 429'
    )
  })

  it('accepts a zero disk reserve, which only disables the reserve check', () => {
    assert.equal(resolveStorageConfig({ diskReserveBytes: 0 }, UPLOAD_LIMIT).diskReserveBytes, 0)
  })
})

describe('resolveReplicationConfig', () => {
  it('places copies by default, since doing so needs no configuration', () => {
    assert.deepEqual(resolveReplicationConfig(undefined), DEFAULT_REPLICATION_CONFIG)
    assert.equal(DEFAULT_REPLICATION_CONFIG.enabled, true)
  })

  it('can be turned off, leaving every file in a single copy', () => {
    assert.equal(resolveReplicationConfig({ enabled: false }).enabled, false)
  })

  it('reduces copies as files age', () => {
    const tiers = DEFAULT_REPLICATION_CONFIG.placement

    assert.equal(tiers[0].minAgeMs, 0)
    for (let index = 1; index < tiers.length; index += 1) {
      assert.ok(tiers[index].minAgeMs > tiers[index - 1].minAgeMs)
      assert.ok(tiers[index].copies <= tiers[index - 1].copies)
    }
  })

  it('rejects tiers that do not start at age zero', () => {
    assert.throws(
      () => resolveReplicationConfig({ placement: [{ minAgeMs: 1, copies: 2 }] }),
      /placement\[0\].minAgeMs/
    )
  })

  it('rejects tiers that increase copies as a file ages', () => {
    assert.throws(
      () =>
        resolveReplicationConfig({
          placement: [
            { minAgeMs: 0, copies: 2 },
            { minAgeMs: 1000, copies: 4 }
          ]
        }),
      /placement\[1\].copies/
    )
  })

  it('rejects tiers that go backwards', () => {
    assert.throws(
      () =>
        resolveReplicationConfig({
          placement: [
            { minAgeMs: 0, copies: 3 },
            { minAgeMs: 0, copies: 2 }
          ]
        }),
      /placement\[1\].minAgeMs/
    )
  })

  it('rejects an empty placement policy', () => {
    assert.throws(() => resolveReplicationConfig({ placement: [] }), /replication.placement/)
  })

  it('rejects a quorum larger than any tier can provide', () => {
    assert.throws(
      () =>
        resolveReplicationConfig({
          placement: [{ minAgeMs: 0, copies: 2 }],
          ackQuorum: 3
        }),
      /ackQuorum/
    )
  })

  it('accepts a complete policy', () => {
    const replication = resolveReplicationConfig({
      enabled: true,
      placement: [
        { minAgeMs: 0, copies: 4 },
        { minAgeMs: 1000, copies: 2 }
      ],
      ackQuorum: 2,
      requireQuorumOnUpload: true
    })

    assert.equal(replication.placement.length, 2)
    assert.equal(replication.ackQuorum, 2)
    assert.equal(replication.requireQuorumOnUpload, true)
  })

  it('rejects a strict upload that could succeed with only the local copy', () => {
    assert.throws(
      () => resolveReplicationConfig({ ackQuorum: 1, requireQuorumOnUpload: true }),
      /ackQuorum/
    )
  })

  it('validates the pause between bounded repair passes', () => {
    assert.equal(resolveReplicationConfig({ repairBatchDelayMs: 0 }).repairBatchDelayMs, 0)
    assert.throws(() => resolveReplicationConfig({ repairBatchDelayMs: -1 }), /repairBatchDelayMs/)
  })

  it('validates repair probe concurrency', () => {
    assert.equal(resolveReplicationConfig({ repairProbeConcurrency: 8 }).repairProbeConcurrency, 8)
    assert.throws(
      () => resolveReplicationConfig({ repairProbeConcurrency: 0 }),
      /repairProbeConcurrency/
    )
  })
})
