import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isStalePeerSessionError } from '../src/peering/recovery.js'

describe('isStalePeerSessionError', () => {
  it('matches replication stream failures seen on testnet', () => {
    assert.equal(isStalePeerSessionError('Replication request failed: Cannot write to a stream that is closed'), true)
    assert.equal(
      isStalePeerSessionError('Replication request failed: Replication stream ended before a complete message arrived'),
      true
    )
    assert.equal(isStalePeerSessionError('Replication request timed out'), true)
  })

  it('ignores unrelated errors', () => {
    assert.equal(isStalePeerSessionError('Not authorized'), false)
    assert.equal(isStalePeerSessionError('No room for another copy'), false)
  })
})
