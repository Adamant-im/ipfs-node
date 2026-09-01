import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RepairCycleDriver } from '../src/storage/repairCycleDriver.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RepairCycleDriver', () => {
  it('retries a continuation that fires during a manual pass', async () => {
    const startupDone = deferred<{ cycleCompleted: boolean }>()
    const manualDone = deferred<{ cycleCompleted: boolean }>()
    const continuationDone = deferred<void>()
    let passes = 0
    const driver = new RepairCycleDriver({
      delayMs: 20,
      busyError: () => new Error('busy'),
      runPass: () => {
        passes += 1
        if (passes === 1) return startupDone.promise
        if (passes === 2) return manualDone.promise
        continuationDone.resolve()
        return Promise.resolve({ cycleCompleted: true })
      }
    })

    driver.start()
    startupDone.resolve({ cycleCompleted: false })
    await startupDone.promise
    await new Promise((resolve) => setImmediate(resolve))

    const manual = driver.runManual()
    // Let the pending automatic continuation fire while the manual pass owns the driver.
    await new Promise((resolve) => setTimeout(resolve, 25))
    manualDone.resolve({ cycleCompleted: false })
    await manual
    await continuationDone.promise

    assert.equal(passes, 3)
    await driver.stop()
  })

  it('rejects a manual pass while automatic repair is active', async () => {
    const active = deferred<{ cycleCompleted: boolean }>()
    const driver = new RepairCycleDriver({
      delayMs: 1,
      busyError: () => new Error('busy'),
      runPass: () => active.promise
    })

    driver.start()
    await assert.rejects(driver.runManual(), /busy/)
    active.resolve({ cycleCompleted: true })
    await driver.stop()
  })

  it('refuses a manual pass once the driver is stopped', async () => {
    let passes = 0
    const driver = new RepairCycleDriver({
      delayMs: 1,
      busyError: () => new Error('busy'),
      runPass: () => {
        passes += 1
        return Promise.resolve({ cycleCompleted: true })
      }
    })

    driver.start()
    await driver.stop()

    // Shutdown already awaited the active pass; a pass admitted now would write
    // cycle evidence against a closing datastore with nothing waiting for it.
    await assert.rejects(driver.runManual(), /busy/)
    assert.equal(passes, 1)
  })

  it('retries a failed pass instead of dropping the cycle', async () => {
    const results: Array<Promise<{ cycleCompleted: boolean }>> = [
      Promise.reject(new Error('datastore unavailable')),
      Promise.resolve({ cycleCompleted: true })
    ]
    results[0].catch(() => undefined)
    const completed = deferred<void>()
    let passes = 0
    const driver = new RepairCycleDriver({
      delayMs: 5,
      busyError: () => new Error('busy'),
      runPass: () => {
        passes += 1
        const next = results.shift()
        if (next === undefined) return Promise.resolve({ cycleCompleted: true })
        if (passes === 2) void next.then(() => completed.resolve())
        return next
      },
      onError: () => undefined
    })

    driver.start()
    await completed.promise

    assert.equal(passes, 2)
    await driver.stop()
  })

  it('abandons the cycle after repeated failures instead of retrying forever', async () => {
    const abandoned = deferred<number>()
    let passes = 0
    const driver = new RepairCycleDriver({
      delayMs: 1,
      maxConsecutiveFailures: 2,
      busyError: () => new Error('busy'),
      runPass: () => {
        passes += 1
        return Promise.reject(new Error('still failing'))
      },
      onError: () => undefined,
      onAbandon: (unused, failures) => {
        void unused
        abandoned.resolve(failures)
      }
    })

    driver.start()
    assert.equal(await abandoned.promise, 2)

    // The budget is spent, so nothing keeps retrying until a new trigger.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(passes, 2)
    await driver.stop()
  })
})
