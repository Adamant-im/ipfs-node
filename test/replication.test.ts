import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { multiaddr } from '@multiformats/multiaddr'
import type { ReplicationConfig } from '../src/storage/config.js'
import { placeFile, storageTargets } from '../src/storage/placement.js'
import {
  isUnderReplicated,
  replicate,
  requiredAcks,
  type ReplicationPeer
} from '../src/storage/replication.js'

const DAY = 24 * 60 * 60 * 1000
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const SELF = 'self-peer'

const baseConfig: ReplicationConfig = {
  enabled: true,
  placement: [
    { minAgeMs: 0, copies: 3 },
    { minAgeMs: 365 * DAY, copies: 2 }
  ],
  ackQuorum: 2,
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

const PEERS = [peer('ipfs2'), peer('ipfs3'), peer('ipfs4'), peer('ipfs5')]

const placementFor = (ageMs: number, peers = PEERS) =>
  placeFile({
    cid: CID,
    ageMs,
    tiers: baseConfig.placement,
    selfPeerId: SELF,
    peerIds: peers.map((item) => item.peerId)
  })

describe('replicate', () => {
  it('reports best effort storage when replication is disabled', async () => {
    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: { ...baseConfig, enabled: false },
      store: async () => assert.fail('peers must not be contacted')
    })

    assert.equal(report.mode, 'best-effort')
    assert.equal(report.acknowledged, 1)
    assert.equal(report.satisfied, true)
  })

  it('places copies on a subset rather than on every peer', async () => {
    const asked: string[] = []

    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async (target) => {
        asked.push(target.name)
        return 'stored'
      }
    })

    // Four peers are available, but a fresh file only wants three holders
    assert.ok(asked.length < PEERS.length, `asked ${asked.length} of ${PEERS.length} peers`)
    assert.equal(asked.length, storageTargets(placementFor(0), SELF).length)
    assert.equal(report.copies, 3)
  })

  it('asks fewer peers as a file ages', async () => {
    const askedFresh: string[] = []
    const askedOld: string[] = []

    await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async (target) => {
        askedFresh.push(target.name)
        return 'stored'
      }
    })
    await replicate({
      cid: CID,
      ageMs: 400 * DAY,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async (target) => {
        askedOld.push(target.name)
        return 'stored'
      }
    })

    assert.ok(askedOld.length < askedFresh.length)
  })

  it('counts the local copy towards the quorum', async () => {
    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async (target) => {
        if (target.name !== storageTargets(placementFor(0), SELF)[0].replace('peer-id-', '')) {
          throw new Error('unreachable')
        }
        return 'stored'
      }
    })

    assert.equal(report.acknowledged, report.replicas.length + 1)
    assert.equal(report.satisfied, report.acknowledged >= report.required)
  })

  it('reports an unsatisfied quorum when no peer acknowledges', async () => {
    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async () => {
        throw new Error('connection refused')
      }
    })

    assert.equal(report.acknowledged, 1)
    assert.equal(report.satisfied, false)
    assert.ok(report.attempts.every((attempt) => !attempt.ok))
  })

  it('does not demand a quorum the network cannot reach', async () => {
    const single = [peer('ipfs2')]

    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: single,
      config: { ...baseConfig, ackQuorum: 3 },
      store: async () => 'stored'
    })

    assert.equal(report.networkTooSmall, true)
    assert.equal(report.required, 2)
    assert.equal(report.satisfied, true)
  })

  it('counts each peer identity once when it has several configured addresses', async () => {
    const duplicate = {
      ...peer('ipfs2-alias'),
      peerId: PEERS[0].peerId,
      multiAddr: multiaddr('/ip4/127.0.0.2/tcp/4001')
    }
    const uniquePeers = [PEERS[0], duplicate, PEERS[1]]
    const contacted = new Set<string>()

    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: uniquePeers,
      config: {
        ...baseConfig,
        placement: [{ minAgeMs: 0, copies: 4 }],
        ackQuorum: 4
      },
      store: async (target) => {
        assert.equal(contacted.has(target.peerId), false, `${target.peerId} was contacted twice`)
        contacted.add(target.peerId)
        return 'stored'
      }
    })

    assert.equal(contacted.size, 2)
    assert.equal(report.copies, 3)
    assert.equal(report.required, 3)
    assert.equal(report.acknowledged, 3)
    assert.equal(report.satisfied, true)
  })
})

describe('placement outcomes', () => {
  it('does not count an unpinned copy towards durability', async () => {
    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async () => 'cached'
    })

    // Peers hold the file and can serve it, but none of them promised to keep it
    assert.deepEqual(report.replicas, [])
    assert.ok(report.cached.length > 0)
    assert.equal(report.acknowledged, 1)
  })

  it('spreads an unpinned file wider than a pinned one', async () => {
    const cachedOn: string[] = []

    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async () => 'cached',
      cacheOnly: async (peer) => {
        cachedOn.push(peer.name)
      }
    })

    // Nobody pinned it, so it rests on copies that can go at any moment; more
    // of them is the only compensation available
    assert.deepEqual(report.replicas, [])
    assert.ok(cachedOn.length > 0, 'extra peers must be asked')
    assert.ok(report.cached.length > storageTargets(placementFor(0), SELF).length)
  })

  it('does not widen when a peer took responsibility', async () => {
    const cachedOn: string[] = []

    await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async () => 'stored',
      cacheOnly: async (peer) => {
        cachedOn.push(peer.name)
      }
    })

    assert.deepEqual(cachedOn, [])
  })

  it('reports stored and cached copies separately', async () => {
    let first = true
    const report = await replicate({
      cid: CID,
      ageMs: 0,
      selfPeerId: SELF,
      peers: PEERS,
      config: baseConfig,
      store: async () => {
        const outcome: 'stored' | 'cached' = first ? 'stored' : 'cached'
        first = false
        return outcome
      }
    })

    assert.equal(report.replicas.length, 1)
    assert.equal(report.cached.length, report.attempts.length - 1)
    assert.equal(report.acknowledged, 2)
  })
})

describe('requiredAcks', () => {
  it('never exceeds the copies that can exist', () => {
    assert.equal(requiredAcks({ ...baseConfig, ackQuorum: 3 }, placementFor(0)), 3)
    assert.equal(requiredAcks({ ...baseConfig, ackQuorum: 3 }, placementFor(0, [peer('only')])), 2)
  })
})

describe('isUnderReplicated', () => {
  it('compares against the peers the placement designated', () => {
    const placement = placementFor(0)
    const targets = storageTargets(placement, SELF).length

    assert.equal(isUnderReplicated(targets, placement, SELF), false)
    assert.equal(isUnderReplicated(targets - 1, placement, SELF), true)
  })

  it('reports nothing missing when the network is too small to place more', () => {
    const placement = placementFor(0, [peer('only')])

    assert.equal(isUnderReplicated(1, placement, SELF), false)
  })
})
