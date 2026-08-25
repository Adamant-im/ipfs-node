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

  it('refuses a second lease to work that already holds one', async () => {
    // With a collector queued, a shared holder asking for another shared lease
    // waits behind the collector while the collector waits for the readers to
    // reach zero. Nothing moves and nothing is logged, so the guard makes the
    // mistake fail where it is made.
    const lock = new StorageOperationLock()

    await assert.rejects(
      () => lock.withShared(async () => lock.withShared(async () => undefined)),
      /Deadlock avoided/
    )

    await assert.rejects(
      () => lock.withShared(async () => lock.withExclusive(async () => undefined)),
      /Deadlock avoided/
    )
  })

  it('lets sequential leases through after the first one is given back', async () => {
    const lock = new StorageOperationLock()

    await lock.withShared(async () => undefined)
    await assert.doesNotReject(() => lock.withExclusive(async () => undefined))
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
