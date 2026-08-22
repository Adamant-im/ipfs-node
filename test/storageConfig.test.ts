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
    assert.throws(() => resolveStorageConfig({ temporaryTtlMs: 0 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ diskReserveBytes: -1 }, UPLOAD_LIMIT))
    assert.throws(() => resolveStorageConfig({ confirmationRequired: 'yes' }, UPLOAD_LIMIT))
  })

  it('accepts a zero disk reserve, which only disables the reserve check', () => {
    assert.equal(resolveStorageConfig({ diskReserveBytes: 0 }, UPLOAD_LIMIT).diskReserveBytes, 0)
  })
})

describe('resolveReplicationConfig', () => {
  const token = 'r'.repeat(64)

  it('defaults to disabled best-effort storage', () => {
    assert.deepEqual(resolveReplicationConfig(undefined), DEFAULT_REPLICATION_CONFIG)
    assert.equal(DEFAULT_REPLICATION_CONFIG.enabled, false)
  })

  it('rejects a quorum larger than the replication factor', () => {
    assert.throws(
      () => resolveReplicationConfig({ enabled: true, factor: 2, ackQuorum: 3, token }),
      /ackQuorum/
    )
  })

  it('rejects enabling replication without a peer token', () => {
    assert.throws(() => resolveReplicationConfig({ enabled: true }), /replication.token/)
    assert.throws(
      () => resolveReplicationConfig({ enabled: true, token: 'short' }),
      /replication.token/
    )
  })

  it('accepts a complete policy', () => {
    const replication = resolveReplicationConfig({
      enabled: true,
      factor: 3,
      ackQuorum: 2,
      requireQuorumOnUpload: true,
      token
    })

    assert.equal(replication.factor, 3)
    assert.equal(replication.ackQuorum, 2)
    assert.equal(replication.requireQuorumOnUpload, true)
  })
})
