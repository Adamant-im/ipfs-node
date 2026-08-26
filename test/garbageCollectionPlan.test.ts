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
    heldLocally: true,
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

  it('evicts for the reserve even when the blockstore is below the low watermark', () => {
    // The watermarks say nothing about free space. A small blockstore on a full
    // volume is under no watermark pressure at all, and comparing against one
    // would have this run reclaim nothing while the disk stayed full.
    const plan = planGarbageCollection({
      blockstoreBytes: 1000,
      watermarks: { highWatermarkBytes: 4000, lowWatermarkBytes: 3000 },
      availableBytes: 400,
      reserveBytes: 500,
      records: [record({ cid: 'a', state: 'temporary', expiresAt: 9000, storedBytes: 300 })],
      now: 1000
    })

    assert.equal(plan.trigger, 'disk-reserve')
    assert.deepEqual(
      plan.evicted.map((item) => item.cid),
      ['a']
    )
  })

  it('keeps evicting until the reserve is honoured again, not until the first file', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 1000,
      watermarks: { highWatermarkBytes: 4000, lowWatermarkBytes: 3000 },
      availableBytes: 400,
      reserveBytes: 500,
      records: [
        record({ cid: 'a', state: 'temporary', createdAt: 1, expiresAt: 9000, storedBytes: 100 }),
        record({ cid: 'b', state: 'temporary', createdAt: 2, expiresAt: 9000, storedBytes: 100 }),
        record({ cid: 'c', state: 'temporary', createdAt: 3, expiresAt: 9000, storedBytes: 100 }),
        record({ cid: 'd', state: 'temporary', createdAt: 4, expiresAt: 9000, storedBytes: 100 })
      ],
      now: 1000
    })

    // 500 * 1.25 - 400 = 225 bytes short, so three files are needed
    assert.deepEqual(
      plan.evicted.map((item) => item.cid),
      ['a', 'b', 'c']
    )
  })

  it('counts what the expired files already free towards the reserve', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 1000,
      watermarks: { highWatermarkBytes: 4000, lowWatermarkBytes: 3000 },
      availableBytes: 400,
      reserveBytes: 500,
      records: [
        record({ cid: 'gone', state: 'temporary', expiresAt: 500, storedBytes: 300 }),
        record({ cid: 'alive', state: 'temporary', expiresAt: 9000, storedBytes: 300 })
      ],
      now: 1000
    })

    assert.deepEqual(
      plan.expired.map((item) => item.cid),
      ['gone']
    )
    assert.deepEqual(plan.evicted, [])
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

  it('collects already-unpinned bytes before evicting a live upload', () => {
    const plan = planGarbageCollection({
      blockstoreBytes: 1100,
      reclaimableBytes: 600,
      watermarks,
      records: [
        record({
          cid: 'pending',
          state: 'temporary',
          expiresAt: 9000,
          storedBytes: 400,
          protectedBytes: 400
        })
      ],
      now: 1000
    })

    assert.equal(plan.shouldCollect, true)
    assert.deepEqual(plan.evicted, [])
    assert.equal(plan.estimatedBytesAfter, 500)
  })

  it('does not evict a live replica stage before its source settles it', () => {
    const staged = record({
      cid: 'prepared',
      state: 'temporary',
      expiresAt: 9000,
      replicaStage: { transactionIds: ['upload-1'], previous: null }
    })
    const plan = planGarbageCollection({
      blockstoreBytes: 5000,
      watermarks,
      records: [staged],
      now: 1000
    })

    assert.equal(plan.shouldCollect, true)
    assert.deepEqual(plan.expired, [])
    assert.deepEqual(plan.evicted, [])
    assert.deepEqual(plan.retained, [staged])
  })
})
