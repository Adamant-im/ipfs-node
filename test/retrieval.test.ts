import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { multiaddr } from '@multiformats/multiaddr'
import type { ReplicationConfig } from '../src/storage/config.js'
import { placeFile } from '../src/storage/placement.js'
import type { ReplicationPeer } from '../src/storage/replication.js'
import { retrievalTargets } from '../src/storage/retrieval.js'

const DAY = 24 * 60 * 60 * 1000
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const SELF = 'self-peer'

const config: ReplicationConfig = {
  enabled: true,
  placement: [
    { minAgeMs: 0, copies: 4 },
    { minAgeMs: 180 * DAY, copies: 3 },
    { minAgeMs: 365 * DAY, copies: 2 }
  ],
  ackQuorum: 1,
  requireQuorumOnUpload: false,
  requestTimeoutMs: 1000,
  repairEnabled: true,
  repairSchedule: '0 * * * * *'
}

const peer = (name: string): ReplicationPeer => ({
  name,
  peerId: `peer-id-${name}`,
  multiAddr: multiaddr('/ip4/127.0.0.1/tcp/4001')
})

const PEERS = Array.from({ length: 9 }, (unused, index) => peer(`n${index}`))

describe('retrievalTargets', () => {
  it('asks a handful of nodes rather than the whole network', () => {
    const targets = retrievalTargets(CID, config, SELF, PEERS)

    assert.ok(targets.length <= 6, `asked ${targets.length} of ${PEERS.length}`)
    assert.ok(targets.length > 0)
  })

  it('reaches a little past the designated holders, to cover membership drift', () => {
    const exact = retrievalTargets(CID, config, SELF, PEERS, 0)
    const widened = retrievalTargets(CID, config, SELF, PEERS)

    assert.ok(widened.length > exact.length)
    for (const target of exact) {
      assert.ok(widened.some((item) => item.peerId === target.peerId))
    }
  })

  it('covers the holders of a file of any age', () => {
    // A node asked for a file it never stored does not know how old it is, so
    // the target set has to be right without that knowledge
    const targets = new Set(retrievalTargets(CID, config, SELF, PEERS).map((item) => item.peerId))

    for (const ageMs of [0, 200 * DAY, 400 * DAY, 10 * 365 * DAY]) {
      const holders = placeFile({
        cid: CID,
        ageMs,
        tiers: config.placement,
        selfPeerId: SELF,
        peerIds: PEERS.map((item) => item.peerId)
      }).holders.filter((peerId) => peerId !== SELF)

      for (const holder of holders) {
        assert.ok(targets.has(holder), `age ${ageMs} holder ${holder} is not a retrieval target`)
      }
    }
  })

  it('never returns itself', () => {
    const targets = retrievalTargets(CID, config, SELF, PEERS)

    assert.equal(
      targets.some((item) => item.peerId === SELF),
      false
    )
  })

  it('falls back to every known node when replication is disabled', () => {
    const targets = retrievalTargets(CID, { ...config, enabled: false }, SELF, PEERS)

    assert.deepEqual(targets, PEERS)
  })
})
