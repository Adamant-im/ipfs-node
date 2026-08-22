import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  copiesForAge,
  effectiveCopies,
  mayDemote,
  placeFile,
  rankHolders,
  storageTargets,
  type PlacementTier
} from '../src/storage/placement.js'

const DAY = 24 * 60 * 60 * 1000

const TIERS: PlacementTier[] = [
  { minAgeMs: 0, copies: 4 },
  { minAgeMs: 180 * DAY, copies: 3 },
  { minAgeMs: 365 * DAY, copies: 2 }
]

const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const PEERS = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e', 'peer-f']

describe('copiesForAge', () => {
  it('spreads fresh content widest', () => {
    assert.equal(copiesForAge(TIERS, 0), 4)
    assert.equal(copiesForAge(TIERS, 179 * DAY), 4)
  })

  it('reduces copies as a file ages', () => {
    assert.equal(copiesForAge(TIERS, 180 * DAY), 3)
    assert.equal(copiesForAge(TIERS, 364 * DAY), 3)
    assert.equal(copiesForAge(TIERS, 365 * DAY), 2)
    assert.equal(copiesForAge(TIERS, 10 * 365 * DAY), 2)
  })
})

describe('effectiveCopies', () => {
  it('never asks for more copies than there are nodes', () => {
    assert.equal(effectiveCopies(4, 2), 2)
    assert.equal(effectiveCopies(4, 9), 4)
  })

  it('always keeps at least one copy', () => {
    assert.equal(effectiveCopies(4, 0), 1)
  })
})

describe('rankHolders', () => {
  it('is deterministic and independent of the input order', () => {
    const forward = rankHolders(CID, PEERS)
    const backward = rankHolders(CID, [...PEERS].reverse())

    assert.deepEqual(forward, backward)
    assert.equal(forward.length, PEERS.length)
  })

  it('ranks different CIDs differently, so load spreads across nodes', () => {
    const winners = new Set(
      Array.from({ length: 40 }, (unused, index) => rankHolders(`${CID}-${index}`, PEERS)[0])
    )

    assert.ok(winners.size > 1, 'one node must not win every CID')
  })

  it('keeps the surviving order when a node leaves', () => {
    const before = rankHolders(CID, PEERS)
    const after = rankHolders(
      CID,
      PEERS.filter((peer) => peer !== before[0])
    )

    assert.deepEqual(after, before.slice(1))
  })
})

describe('placeFile', () => {
  const place = (ageMs: number, peerIds = PEERS.slice(0, 5)) =>
    placeFile({ cid: CID, ageMs, tiers: TIERS, selfPeerId: 'self', peerIds })

  it('designates the age-appropriate number of holders', () => {
    assert.equal(place(0).holders.length, 4)
    assert.equal(place(365 * DAY).holders.length, 2)
  })

  it('reaches the same answer on every node', () => {
    const fromSelf = placeFile({
      cid: CID,
      ageMs: 0,
      tiers: TIERS,
      selfPeerId: 'peer-a',
      peerIds: ['self', 'peer-b', 'peer-c']
    })
    const fromPeer = placeFile({
      cid: CID,
      ageMs: 0,
      tiers: TIERS,
      selfPeerId: 'peer-b',
      peerIds: ['self', 'peer-a', 'peer-c']
    })

    assert.deepEqual(fromSelf.holders.sort(), fromPeer.holders.sort())
  })

  it('puts the file on every node when the network is smaller than the desired count', () => {
    // Three nodes in total, four copies wanted: all three hold it, and the
    // fourth copy is not looked for on a node that does not exist
    const placement = place(0, ['peer-a', 'peer-b'])

    assert.equal(placement.desiredCopies, 4)
    assert.equal(placement.copies, 3)
    assert.deepEqual(placement.holders.sort(), ['peer-a', 'peer-b', 'self'])
    assert.equal(placement.selfIsHolder, true)
    assert.deepEqual(storageTargets(placement, 'self').sort(), ['peer-a', 'peer-b'])
    assert.equal(placement.networkTooSmall, true)
    assert.equal(mayDemote(placement), false)
  })

  it('asks nobody when it is the only node', () => {
    const placement = place(0, [])

    assert.equal(placement.copies, 1)
    assert.deepEqual(storageTargets(placement, 'self'), [])
    assert.equal(mayDemote(placement), false)
  })

  it('stops growing the holder set once the network is large enough', () => {
    const placement = place(0, ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'])

    assert.equal(placement.copies, 4)
    assert.equal(placement.holders.length, 4)
    assert.equal(placement.networkTooSmall, false)
  })

  it('never asks itself to store a copy it already has', () => {
    const placement = place(0)

    assert.equal(storageTargets(placement, 'self').includes('self'), false)
    assert.equal(
      storageTargets(placement, 'self').length,
      placement.selfIsHolder ? placement.copies - 1 : placement.copies
    )
  })
})

describe('mayDemote', () => {
  const base = { desiredCopies: 4, copies: 4, holders: [] as string[] }

  it('lets a node outside the designated set release its copy', () => {
    assert.equal(mayDemote({ ...base, selfIsHolder: false, networkTooSmall: false }), true)
  })

  it('never lets a designated holder release its copy', () => {
    assert.equal(mayDemote({ ...base, selfIsHolder: true, networkTooSmall: false }), false)
  })

  it('never releases anything while the network is too small', () => {
    assert.equal(mayDemote({ ...base, selfIsHolder: false, networkTooSmall: true }), false)
  })
})
