import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  INTAKE_WINDOW_MS,
  PER_PEER_INTAKE_BYTES,
  PER_PEER_INTAKE_REQUESTS,
  reserveIntake,
  resetIntakeBudget,
  TOTAL_INTAKE_BYTES
} from '../src/storage/intakeBudget.js'

/** Aligned to a bucket boundary, so the arithmetic in the tests is readable. */
const NOW = 10 * INTAKE_WINDOW_MS
const COPY = 512 * 1024 ** 2

beforeEach(() => resetIntakeBudget())

describe('cache intake budget', () => {
  it('lets an idle peer through', () => {
    assert.notEqual(reserveIntake('peer-a', COPY, NOW), undefined)
  })

  it('stops a peer that spent its bytes', () => {
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)?.settle(PER_PEER_INTAKE_BYTES)

    assert.equal(reserveIntake('peer-a', 1, NOW), undefined)
  })

  it('leaves other peers alone when one is spent', () => {
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)?.settle(PER_PEER_INTAKE_BYTES)

    assert.notEqual(reserveIntake('peer-b', COPY, NOW), undefined)
  })

  it('charges the maximum up front, so concurrent pulls cannot all pass', () => {
    // All but one byte of the budget is already gone
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES - 1, NOW)?.settle(PER_PEER_INTAKE_BYTES - 1)

    // Every intake slot asks at once; reading the counters alone would admit
    // them all, because none of them has finished to be counted yet
    const granted = Array.from({ length: 8 }, () => reserveIntake('peer-a', COPY, NOW)).filter(
      (reservation) => reservation !== undefined
    )

    assert.equal(granted.length, 0)
  })

  it('gives back only what the transfer did not use', () => {
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW)?.settle(0)

    assert.notEqual(reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW), undefined)
  })

  it('charges an aborted transfer for the bytes it already moved', () => {
    // A peer that sends almost a whole copy and then withholds the tail has
    // spent the bandwidth, whether or not the pull resolved
    reserveIntake('peer-a', COPY, NOW)?.settle(COPY - 1)

    assert.equal(reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, NOW), undefined)
  })

  it('charges the excess when a transfer cost more than was reserved', () => {
    reserveIntake('peer-a', COPY, NOW)?.settle(PER_PEER_INTAKE_BYTES)

    assert.equal(reserveIntake('peer-a', 1, NOW), undefined)
  })

  it('counts a request that moved nothing, so asking is never free', () => {
    for (let i = 0; i < PER_PEER_INTAKE_REQUESTS; i += 1) {
      reserveIntake('peer-a', 1, NOW)?.settle(0)
    }

    assert.equal(reserveIntake('peer-a', 1, NOW), undefined)
  })

  it('stops everyone once the node-wide budget is spent', () => {
    // Minting identities is free until node membership exists, so the shared
    // budget is the one that has to hold
    const peers = Math.ceil(TOTAL_INTAKE_BYTES / PER_PEER_INTAKE_BYTES)

    for (let i = 0; i < peers; i += 1) {
      reserveIntake(`peer-${i}`, PER_PEER_INTAKE_BYTES, NOW)?.settle(PER_PEER_INTAKE_BYTES)
    }

    assert.equal(reserveIntake('fresh-peer', COPY, NOW), undefined)
  })

  it('does not hand a peer a second allowance across the hour boundary', () => {
    // A counter reset on the hour would let this peer spend everything at 59
    // minutes and everything again at 61, which is twice the stated limit
    const late = NOW + INTAKE_WINDOW_MS - 60_000
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, late)?.settle(PER_PEER_INTAKE_BYTES)

    assert.equal(reserveIntake('peer-a', 1, late + 120_000), undefined)
  })

  it('opens the budget again once the spend is really an hour old', () => {
    const late = NOW + INTAKE_WINDOW_MS - 60_000
    reserveIntake('peer-a', PER_PEER_INTAKE_BYTES, late)?.settle(PER_PEER_INTAKE_BYTES)

    assert.notEqual(reserveIntake('peer-a', COPY, late + INTAKE_WINDOW_MS), undefined)
  })
})
