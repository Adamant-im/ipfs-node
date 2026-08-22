import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planGarbageCollection } from '../src/storage/gc.js'
import type { FileRecord } from '../src/storage/registry.js'

const watermarks = { highWatermarkBytes: 1000, lowWatermarkBytes: 500 }

function record(overrides: Partial<FileRecord> & Pick<FileRecord, 'cid' | 'state'>): FileRecord {
  return {
    name: 'file',
    createdAt: 0,
    expiresAt: null,
    confirmedAt: null,
    fileSize: 100,
    storedBytes: 100,
    pinned: true,
    replicas: [],
    ...overrides
  }
}

describe('planGarbageCollection', () => {
  it('does not collect while the blockstore is below the high watermark', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 900,
      watermarks,
      records: [record({ cid: 'a', state: 'temporary', expiresAt: 5000 })],
      now: 1000
    })

    assert.equal(plan.shouldCollect, false)
    assert.deepEqual(plan.evicted, [])
  })

  it('releases an abandoned upload once its TTL elapsed, whatever the size is', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 10,
      watermarks,
      records: [record({ cid: 'a', state: 'temporary', expiresAt: 500 })],
      now: 1000
    })

    assert.deepEqual(
      plan.expired.map((item) => item.cid),
      ['a']
    )
  })

  it('never selects confirmed content', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 5000,
      watermarks,
      records: [
        record({ cid: 'durable', state: 'confirmed' }),
        record({ cid: 'temp', state: 'temporary', expiresAt: 9000 })
      ],
      now: 1000
    })

    assert.equal(plan.shouldCollect, true)
    const released = [...plan.expired, ...plan.evicted].map((item) => item.cid)
    assert.deepEqual(released, ['temp'])
    assert.ok(plan.retained.some((item) => item.cid === 'durable'))
  })

  it('evicts the oldest unconfirmed files until the low watermark is reached', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 800,
      watermarks: { highWatermarkBytes: 700, lowWatermarkBytes: 600 },
      records: [
        record({ cid: 'newest', state: 'temporary', createdAt: 300, expiresAt: 9000 }),
        record({ cid: 'oldest', state: 'temporary', createdAt: 100, expiresAt: 9000 }),
        record({ cid: 'middle', state: 'temporary', createdAt: 200, expiresAt: 9000 })
      ],
      now: 1000
    })

    assert.deepEqual(
      plan.evicted.map((item) => item.cid),
      ['oldest', 'middle']
    )
    assert.equal(plan.estimatedBytesAfter, 600)
  })

  it('stops evicting as soon as the estimate is below the low watermark', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 750,
      watermarks: { highWatermarkBytes: 700, lowWatermarkBytes: 700 },
      records: [
        record({ cid: 'a', state: 'temporary', createdAt: 1, expiresAt: 9000 }),
        record({ cid: 'b', state: 'temporary', createdAt: 2, expiresAt: 9000 })
      ],
      now: 1000
    })

    assert.deepEqual(
      plan.evicted.map((item) => item.cid),
      ['a']
    )
  })
})
