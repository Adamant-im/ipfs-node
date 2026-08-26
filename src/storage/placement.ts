import { createHash } from 'node:crypto'

/**
 * How many nodes should hold a file of a given age, including this one.
 *
 * Fresh content is worth spreading widely; old content is rarely fetched, so
 * fewer copies are enough and the rest of the network reclaims the space.
 *
 * Age is used rather than access time on purpose: recording when a file was
 * last read would build a trail of user activity, and sharing that trail
 * between nodes would leak it further. Creation time is already implied by the
 * upload itself, so it reveals nothing new.
 */
export interface PlacementTier {
  /** Smallest file age this tier applies to, in milliseconds. */
  minAgeMs: number
  /** Desired holders, including this node. */
  copies: number
}

/**
 * Desired holders for a file of `ageMs`.
 *
 * @param tiers Tiers ordered by `minAgeMs`, starting at zero
 */
export function copiesForAge(tiers: PlacementTier[], ageMs: number): number {
  let copies = tiers[0]?.copies ?? 1

  for (const tier of tiers) {
    if (ageMs >= tier.minAgeMs) {
      copies = tier.copies
    }
  }

  return copies
}

/**
 * Copies that can actually exist.
 *
 * A network smaller than the desired count already stores the file everywhere
 * it can, so asking for more only spams peers that cannot help.
 *
 * @param networkSize Nodes known to this one, including itself
 */
export function effectiveCopies(desired: number, networkSize: number): number {
  return Math.max(1, Math.min(desired, networkSize))
}

/** Score of one node for one CID; higher wins. */
function score(peerId: string, cid: string): bigint {
  return createHash('sha256').update(peerId).update(cid).digest().readBigUInt64BE(0)
}

/**
 * Rank nodes for a CID with rendezvous hashing.
 *
 * Every node computes the same ranking without talking to anyone, so the set of
 * designated holders is agreed by construction rather than negotiated. Adding
 * or removing a node moves only the fraction of CIDs it wins or loses, instead
 * of reshuffling all of them the way a modulo assignment would.
 *
 * @param peerIds Candidate nodes, including this one
 * @returns The same identifiers, best first
 */
export function rankHolders(cid: string, peerIds: string[]): string[] {
  return [...peerIds].sort((a, b) => {
    const left = score(a, cid)
    const right = score(b, cid)

    if (left !== right) {
      return left > right ? -1 : 1
    }

    // Equal scores are vanishingly unlikely, but the order must still be total
    // and identical on every node.
    return a < b ? -1 : 1
  })
}

export interface PlacementInput {
  cid: string
  /** Age of the file in milliseconds. */
  ageMs: number
  tiers: PlacementTier[]
  /** This node's peer id. */
  selfPeerId: string
  /** Peer ids of the other known ADAMANT nodes. */
  peerIds: string[]
}

export interface Placement {
  /** Holders the age policy asks for, including this node. */
  desiredCopies: number
  /** Holders that can exist given the size of the network. */
  copies: number
  /** Designated holders, best first. */
  holders: string[]
  /** True when this node is one of them. */
  selfIsHolder: boolean
  /**
   * True when the network is no larger than the desired copy count, so every
   * node is expected to hold the file and none of them may drop it.
   */
  networkTooSmall: boolean
}

/** Resolve where a file belongs right now. */
export function placeFile(input: PlacementInput): Placement {
  const candidates = [...new Set([input.selfPeerId, ...input.peerIds])]
  const desiredCopies = copiesForAge(input.tiers, input.ageMs)
  const copies = effectiveCopies(desiredCopies, candidates.length)
  const holders = rankHolders(input.cid, candidates).slice(0, copies)

  return {
    desiredCopies,
    copies,
    holders,
    selfIsHolder: holders.includes(input.selfPeerId),
    networkTooSmall: candidates.length <= desiredCopies
  }
}

/**
 * Peers this node should ask to store a file, which is the designated holders
 * minus itself.
 */
export function storageTargets(placement: Placement, selfPeerId: string): string[] {
  return placement.holders.filter((peerId) => peerId !== selfPeerId)
}

/**
 * Whether this node may stop holding a file.
 *
 * Only a node outside the designated set may drop its copy, and the designated
 * set is identical on every node, so the nodes that must keep the file never
 * decide to drop it. That is what stops two nodes from dropping the last two
 * copies at the same time, without any locking between them.
 *
 * A network no larger than the desired copy count never drops anything: every
 * node is expected to hold the file, and there is nowhere for the copy to move.
 */
export function mayDemote(placement: Placement): boolean {
  return !placement.networkTooSmall && !placement.selfIsHolder
}
