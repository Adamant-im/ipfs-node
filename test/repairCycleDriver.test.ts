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
})
