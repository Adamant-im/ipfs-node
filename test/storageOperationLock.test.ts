import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StorageOperationLock } from '../src/storage/operationLock.js'

describe('storage operation lock', () => {
  it('allows shared work to overlap and waits to collect', async () => {
    const lock = new StorageOperationLock()
    const first = await lock.acquireShared()
    const second = await lock.acquireShared()
    let collectorStarted = false

    const collector = lock.acquireExclusive().then((lease) => {
      collectorStarted = true
      return lease
    })

    await Promise.resolve()
    assert.equal(collectorStarted, false)

    first.release()
    await Promise.resolve()
    assert.equal(collectorStarted, false)

    second.release()
    const collectorLease = await collector
    assert.equal(collectorStarted, true)
    collectorLease.release()
  })

  it('does not let later intake overtake a queued collector', async () => {
    const lock = new StorageOperationLock()
    const activeIntake = await lock.acquireShared()
    const order: string[] = []

    const collector = lock.acquireExclusive().then((lease) => {
      order.push('collector')
      return lease
    })
    const laterIntake = lock.acquireShared().then((lease) => {
      order.push('intake')
      return lease
    })

    activeIntake.release()
    const collectorLease = await collector
    assert.deepEqual(order, ['collector'])

    collectorLease.release()
    const intakeLease = await laterIntake
    assert.deepEqual(order, ['collector', 'intake'])
    intakeLease.release()
  })

  it('makes releasing a lease idempotent', async () => {
    const lock = new StorageOperationLock()
    const lease = await lock.acquireShared()

    lease.release()
    lease.release()

    const collector = await lock.acquireExclusive()
    collector.release()
  })
})
