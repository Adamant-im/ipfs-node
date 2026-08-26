import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  REPLICATION_PROTOCOL,
  REPLICATION_PROTOCOL_VERSION,
  SUPPORTED_REPLICATION_PROTOCOLS
} from '../src/storage/replicationProtocol.js'

describe('replication protocol version', () => {
  it('is a libp2p protocol id carrying its own version', () => {
    assert.equal(REPLICATION_PROTOCOL, `/adamant/replication/${REPLICATION_PROTOCOL_VERSION}`)
    assert.match(REPLICATION_PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/)
  })

  it('does not follow the package version', () => {
    // The wire format is what two nodes must agree on, and it changes far less
    // often than the software. Tying them would break interoperability on every
    // release for no reason.
    // The suites run from the project root, where `package.json` lives
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

    assert.notEqual(REPLICATION_PROTOCOL_VERSION, pkg.version)
  })

  it('offers the current version and can offer older ones alongside it', () => {
    assert.ok(SUPPORTED_REPLICATION_PROTOCOLS.includes(REPLICATION_PROTOCOL))
    assert.equal(SUPPORTED_REPLICATION_PROTOCOLS[0], REPLICATION_PROTOCOL)
    assert.equal(
      new Set(SUPPORTED_REPLICATION_PROTOCOLS).size,
      SUPPORTED_REPLICATION_PROTOCOLS.length
    )
  })
})
