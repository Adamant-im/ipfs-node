import type { Multiaddr } from '@multiformats/multiaddr'
import type { ReplicationConfig } from './config.js'
import { placeFile, storageTargets, type Placement } from './placement.js'

/** Another ADAMANT node this one can reach over libp2p. */
export interface ReplicationPeer {
  name: string
  peerId: string
  multiAddr: Multiaddr
}

/**
 * What a peer did with a copy.
 *
 * `stored` means it pinned the file and is responsible for it. `cached` means
 * it holds the blocks and can serve them, but promises nothing: the copy sits
 * in the same tier as read cache and goes when the peer needs the space.
 */
export type PlacementOutcome = 'stored' | 'cached'

export interface ReplicationAck {
  node: string
  ok: boolean
  outcome?: PlacementOutcome
  error?: string
}

export interface ReplicationReport {
  /**
   * `quorum` when the node actively places copies on its peers,
   * `best-effort` when replication is disabled and durability is local only.
   */
  mode: 'quorum' | 'best-effort'
  /** Copies the age policy asks for, including this node. */
  desiredCopies: number
  /** Copies that can exist given how many nodes are known. */
  copies: number
  /** Acknowledgements needed for this upload to count as durable. */
  required: number
  /** Copies confirmed right now, including the one on this node. */
  acknowledged: number
  /** Peer nodes that took responsibility for a copy. */
  replicas: string[]
  /**
   * Peer nodes holding an unpinned copy.
   *
   * They keep the file readable without promising to keep it, which is what a
   * node gets when its peers do not know it yet.
   */
  cached: string[]
  satisfied: boolean
  /**
   * True when the network is no larger than the desired copy count, so every
   * node already holds what it can and there is nowhere else to place a copy.
   */
  networkTooSmall: boolean
  attempts: ReplicationAck[]
}

export interface ReplicateOptions {
  cid: string
  /** Age of the file, which decides how many copies it deserves. */
  ageMs: number
  selfPeerId: string
  peers: ReplicationPeer[]
  config: ReplicationConfig
  /** Asks one peer to take a copy, and reports what it agreed to. */
  store: (peer: ReplicationPeer, cid: string) => Promise<PlacementOutcome>
}

/**
 * Acknowledgements this upload must collect.
 *
 * Bounded by the copies that can actually exist: a three-node network can never
 * satisfy a quorum of four, and reporting a permanent shortfall would be noise
 * rather than information.
 */
export function requiredAcks(config: ReplicationConfig, placement: Placement): number {
  return Math.max(1, Math.min(config.ackQuorum, placement.copies))
}

/**
 * Place copies of a file on the nodes that should hold it.
 *
 * Copies go to a deterministic subset rather than to every peer: with a large
 * node set, copying everywhere costs bandwidth and disk on every node for no
 * added durability. Every node derives the same subset from the CID, so no
 * coordination is needed to agree on who is responsible.
 *
 * When replication is disabled the node reports `best-effort`: the content is
 * stored and pinned locally, and no durability claim is made beyond that.
 */
export async function replicate(options: ReplicateOptions): Promise<ReplicationReport> {
  const { config, cid } = options

  if (!config.enabled) {
    return {
      mode: 'best-effort',
      desiredCopies: 1,
      copies: 1,
      required: 1,
      acknowledged: 1,
      replicas: [],
      cached: [],
      satisfied: true,
      networkTooSmall: true,
      attempts: []
    }
  }

  const placement = placeFile({
    cid,
    ageMs: options.ageMs,
    tiers: config.placement,
    selfPeerId: options.selfPeerId,
    peerIds: options.peers.map((peer) => peer.peerId)
  })

  const targetIds = new Set(storageTargets(placement, options.selfPeerId))
  const targets = options.peers.filter((peer) => targetIds.has(peer.peerId))

  const attempts = await Promise.all(
    targets.map(async (peer): Promise<ReplicationAck> => {
      try {
        return { node: peer.name, ok: true, outcome: await options.store(peer, cid) }
      } catch (err) {
        return { node: peer.name, ok: false, error: (err as Error).message }
      }
    })
  )

  // Only a pinned copy counts towards durability; a cached one can vanish the
  // moment its peer needs the space.
  const replicas = attempts
    .filter((attempt) => attempt.outcome === 'stored')
    .map((attempt) => attempt.node)
  const cached = attempts
    .filter((attempt) => attempt.outcome === 'cached')
    .map((attempt) => attempt.node)

  // The local copy counts: it is pinned before any peer is asked.
  const acknowledged = replicas.length + 1
  const required = requiredAcks(config, placement)

  return {
    mode: 'quorum',
    desiredCopies: placement.desiredCopies,
    copies: placement.copies,
    required,
    acknowledged,
    replicas,
    cached,
    satisfied: acknowledged >= required,
    networkTooSmall: placement.networkTooSmall,
    attempts
  }
}

/**
 * Whether a file holds fewer copies than its placement asks for.
 *
 * @param acknowledgedPeers Peer nodes known to hold a copy, excluding this one
 */
export function isUnderReplicated(
  acknowledgedPeers: number,
  placement: Placement,
  selfPeerId: string
): boolean {
  return acknowledgedPeers < storageTargets(placement, selfPeerId).length
}
