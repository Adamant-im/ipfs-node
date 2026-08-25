import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  INTAKE_WINDOW_MS,
  mayAcceptIntake,
  PER_PEER_INTAKE_BYTES,
  PER_PEER_INTAKE_REQUESTS,
  recordIntake,
  resetIntakeBudget,
  TOTAL_INTAKE_BYTES
} from '../src/storage/intakeBudget.js'

const NOW = 1_000_000

beforeEach(() => resetIntakeBudget())

describe('cache intake budget', () => {
  it('lets an idle peer through', () => {
    assert.equal(mayAcceptIntake('peer-a', NOW), true)
  })

  it('stops a peer that spent its bytes', () => {
    recordIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)

    assert.equal(mayAcceptIntake('peer-a', NOW), false)
  })

  it('leaves other peers alone when one is spent', () => {
    recordIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)

    assert.equal(mayAcceptIntake('peer-b', NOW), true)
  })

  it('counts a failed transfer as a request, so asking is never free', () => {
    for (let i = 0; i < PER_PEER_INTAKE_REQUESTS; i += 1) {
      recordIntake('peer-a', 0, NOW)
    }

    assert.equal(mayAcceptIntake('peer-a', NOW), false)
  })

  it('stops everyone once the node-wide budget is spent', () => {
    // Minting identities is free until node membership exists, so the shared
    // budget is the one that has to hold.
    const peers = Math.ceil(TOTAL_INTAKE_BYTES / PER_PEER_INTAKE_BYTES)

    for (let i = 0; i < peers; i += 1) {
      recordIntake(`peer-${i}`, PER_PEER_INTAKE_BYTES, NOW)
    }

    assert.equal(mayAcceptIntake('fresh-peer', NOW), false)
  })

  it('opens the budget again in the next window', () => {
    recordIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)

    assert.equal(mayAcceptIntake('peer-a', NOW + INTAKE_WINDOW_MS), true)
  })

  it('forgets a peer whose window closed, so the accounting cannot grow forever', () => {
    recordIntake('peer-a', 1, NOW)
    recordIntake('peer-b', 1, NOW + INTAKE_WINDOW_MS)

    // peer-a is gone rather than merely out of date, so a spent identity is not
    // remembered for longer than it can be charged.
    assert.equal(mayAcceptIntake('peer-a', NOW + INTAKE_WINDOW_MS), true)
  })
})
