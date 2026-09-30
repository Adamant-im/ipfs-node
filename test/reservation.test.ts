import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { claimedBytes, claimSpace, resetClaims } from '../src/storage/reservation.js'

const RESERVE = 1000

beforeEach(() => resetClaims())

describe('claimSpace', () => {
  it('grants space while the reserve survives', () => {
    const claim = claimSpace({ bytes: 500, availableBytes: 2000, reserveBytes: RESERVE })

    assert.notEqual(claim, undefined)
    assert.equal(claimedBytes(), 500)
  })

  it('refuses a claim that would break the reserve', () => {
    assert.equal(
      claimSpace({ bytes: 1001, availableBytes: 2000, reserveBytes: RESERVE }),
      undefined
    )
    assert.equal(claimedBytes(), 0)
  })

  it('counts what is already promised, so two claims cannot both fit', () => {
    // Both see the same free space; only the first may have it
    const first = claimSpace({ bytes: 900, availableBytes: 2000, reserveBytes: RESERVE })
    const second = claimSpace({ bytes: 900, availableBytes: 2000, reserveBytes: RESERVE })

    assert.notEqual(first, undefined)
    assert.equal(second, undefined)
  })

  it('lets a later claim through once an earlier one is given back', () => {
    const first = claimSpace({ bytes: 900, availableBytes: 2000, reserveBytes: RESERVE })
    first?.release()

    assert.notEqual(
      claimSpace({ bytes: 900, availableBytes: 2000, reserveBytes: RESERVE }),
      undefined
    )
  })

  it('gives a claim back only once', () => {
    const claim = claimSpace({ bytes: 400, availableBytes: 2000, reserveBytes: RESERVE })

    claim?.release()
    claim?.release()

    assert.equal(claimedBytes(), 0)
  })

  it('refuses everything once free space is already inside the reserve', () => {
    assert.equal(claimSpace({ bytes: 1, availableBytes: 500, reserveBytes: RESERVE }), undefined)
  })
})
