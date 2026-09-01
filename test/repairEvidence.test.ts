import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseEvidence, type RepairCycleEvidence } from '../src/storage/repairEvidence.js'

const NOW = 1_720_614_998_797

const valid: RepairCycleEvidence = {
  membershipVersion: 'a'.repeat(64),
  policyVersion: 'b'.repeat(64),
  startedAt: NOW - 60_000,
  superseded: false,
  examined: 120,
  checked: 100,
  underReplicated: 4,
  repaired: 4,
  stillMissing: 0,
  unrecoverable: 0,
  lastCompletedAt: NOW - 30_000,
  lastCompletedSuccessfully: true,
  lastCompletedBacklog: 0
}

describe('persisted repair evidence', () => {
  it('accepts state this node could have written', () => {
    assert.deepEqual(parseEvidence({ ...valid }, NOW), valid)
  })

  it('rejects a completion stamped ahead of the clock', () => {
    // `evaluateHealth` measures repair freshness from this value, so a future
    // timestamp would read as permanently fresh.
    assert.equal(parseEvidence({ ...valid, lastCompletedAt: NOW + 3_600_000 }, NOW), null)
    assert.equal(parseEvidence({ ...valid, startedAt: NOW + 1_000 }, NOW), null)
  })

  it('rejects negative counters', () => {
    for (const field of [
      'examined',
      'checked',
      'underReplicated',
      'repaired',
      'stillMissing',
      'unrecoverable',
      'lastCompletedBacklog'
    ] as const) {
      assert.equal(parseEvidence({ ...valid, [field]: -1 }, NOW), null, field)
    }
  })

  it('rejects internally inconsistent evidence', () => {
    // More records checked than the cycle ever visited.
    assert.equal(parseEvidence({ ...valid, examined: 10, checked: 20 }, NOW), null)

    // A clean completion cannot carry a backlog.
    assert.equal(
      parseEvidence({ ...valid, lastCompletedSuccessfully: true, lastCompletedBacklog: 3 }, NOW),
      null
    )
  })

  it('accepts a cycle that has never completed', () => {
    const running = { ...valid, lastCompletedAt: null, lastCompletedSuccessfully: false }

    assert.deepEqual(parseEvidence(running, NOW), running)
  })

  it('fills in fields written by an earlier release', () => {
    const legacy = { ...valid }
    delete (legacy as Partial<RepairCycleEvidence>).examined
    delete (legacy as Partial<RepairCycleEvidence>).superseded

    const parsed = parseEvidence(legacy, NOW)

    assert.equal(parsed?.examined, valid.checked)
    assert.equal(parsed?.superseded, false)
  })
})
