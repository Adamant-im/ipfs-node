import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nextSweepBatch, SWEEP_BATCHES } from '../src/storage/sweep.js'

const records = (count: number) =>
  Array.from({ length: count }, (unused, i) => ({ cid: `cid-${i}` }))

describe('nextSweepBatch', () => {
  it('returns everything when the set fits in one pass', () => {
    const all = records(3)

    assert.deepEqual(nextSweepBatch('rescue', all), all)
  })

  it('covers every record across passes instead of repeating the first ones', () => {
    const size = SWEEP_BATCHES.rescue
    const all = records(size * 2 + 7)
    const seen = new Set<string>()

    // Three passes is more than enough to walk a set of this size
    for (let pass = 0; pass < 3; pass += 1) {
      for (const record of nextSweepBatch('rescue', all)) {
        seen.add(record.cid)
      }
    }

    assert.equal(seen.size, all.length, 'every record must be looked at')
  })

  it('never hands back more than the batch size', () => {
    const all = records(SWEEP_BATCHES.demote * 3)

    assert.equal(nextSweepBatch('demote', all).length, SWEEP_BATCHES.demote)
  })

  it('keeps a cursor per sweep, so one does not move another', () => {
    const all = records(SWEEP_BATCHES.repair + 5)

    const firstRepair = nextSweepBatch('repair', all)
    nextSweepBatch('rescue', all)
    const secondRepair = nextSweepBatch('repair', all)

    assert.notDeepEqual(firstRepair[0], secondRepair[0])
  })

  it('reports the next batch without taking it when asked to peek', () => {
    const all = records(SWEEP_BATCHES.demote + 5)

    const peeked = nextSweepBatch('demote', all, { advance: false })
    const taken = nextSweepBatch('demote', all)

    // A dry run must not move the position the real pass resumes from
    assert.deepEqual(peeked, taken)
  })

  it('starts over when the record it stopped at is gone', () => {
    const all = records(SWEEP_BATCHES.rescue + 3)
    nextSweepBatch('rescue', all)

    const replaced = records(SWEEP_BATCHES.rescue + 3).map((record) => ({
      cid: `${record.cid}-new`
    }))

    assert.equal(nextSweepBatch('rescue', replaced).length, SWEEP_BATCHES.rescue)
  })
})
