import type { Multiaddr } from '@multiformats/multiaddr'
import type { ReplicationConfig } from './config.js'
import { placeFile, rankHolders, storageTargets, type Placement } from './placement.js'

/**
 * Extra nodes asked to hold an unpinned copy.
 *
 * An unpinned copy lasts only until its node needs the space, so spreading a
 * file that nobody will pin is worth doing more widely than one that is pinned.
 * Several fragile copies outlive a single one.
 */
export const CACHE_WIDENING = 2

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
  /** Stable identity used to settle a prepared copy without trusting display names. */
  peerId: string
  ok: boolean
  outcome?: PlacementOutcome
  /**
   * True when this copy still belongs to an upload transaction.
   *
   * Set on a failed attempt too when `stage` may have pinned before the ack
   * was lost, so abort can still withdraw it.
   */
  staged?: boolean
  error?: string
}

export interface ReplicationStoreResult {
  outcome: PlacementOutcome | 'failed'
  staged?: boolean
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

/**
 * Upload receipt without peer identity.
 *
 * The internal report names holders and carries raw peer errors. Upload is
 * public, so the HTTP body keeps counts and outcomes only.
 */
export interface PublicReplicationReport {
  mode: ReplicationReport['mode']
  desiredCopies: number
  copies: number
  required: number
  acknowledged: number
  replicaCount: number
  cachedCount: number
  satisfied: boolean
  networkTooSmall: boolean
  failedAttemptCount: number
  attempts: Array<{ ok: boolean; outcome?: PlacementOutcome; staged?: boolean }>
}

/** Strip holder names, peer ids, and error text from an upload receipt. */
export function toPublicReplicationReport(report: ReplicationReport): PublicReplicationReport {
  return {
    mode: report.mode,
    desiredCopies: report.desiredCopies,
    copies: report.copies,
    required: report.required,
    acknowledged: report.acknowledged,
    replicaCount: report.replicas.length,
    cachedCount: report.cached.length,
    satisfied: report.satisfied,
    networkTooSmall: report.networkTooSmall,
    failedAttemptCount: report.attempts.filter((attempt) => !attempt.ok).length,
    attempts: report.attempts.map(({ ok, outcome, staged }) => ({
      ok,
      ...(outcome === undefined ? {} : { outcome }),
      ...(staged === undefined ? {} : { staged })
    }))
  }
}

export interface ReplicateOptions {
  cid: string
  /** Age of the file, which decides how many copies it deserves. */
  ageMs: number
  selfPeerId: string
  peers: ReplicationPeer[]
  config: ReplicationConfig
  /** Asks one peer to take a copy, and reports what it agreed to. */
  store: (peer: ReplicationPeer, cid: string) => Promise<PlacementOutcome | ReplicationStoreResult>
  /** Asks one peer for an unpinned copy, used to widen a spread nobody pins. */
  cacheOnly?: (peer: ReplicationPeer, cid: string) => Promise<void>
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
 * Keep one address for each remote peer identity.
 *
 * A peer can be reachable through several configured multiaddrs, but those
 * addresses still lead to one durability domain. Counting them separately
 * would let one machine satisfy several copies of the quorum.
 */
function distinctPeers(peers: ReplicationPeer[], selfPeerId: string): ReplicationPeer[] {
  const byPeerId = new Map<string, ReplicationPeer>()

  for (const peer of peers) {
    if (peer.peerId !== selfPeerId && !byPeerId.has(peer.peerId)) {
      byPeerId.set(peer.peerId, peer)
    }
  }

  return [...byPeerId.values()]
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

  const peers = distinctPeers(options.peers, options.selfPeerId)

  const placement = placeFile({
    cid,
    ageMs: options.ageMs,
    tiers: config.placement,
    selfPeerId: options.selfPeerId,
    peerIds: peers.map((peer) => peer.peerId)
  })

  const targetIds = new Set(storageTargets(placement, options.selfPeerId))
  const targets = peers.filter((peer) => targetIds.has(peer.peerId))

  const attempts = await Promise.all(
    targets.map(async (peer): Promise<ReplicationAck> => {
      try {
        const stored = await options.store(peer, cid)
        const result = typeof stored === 'string' ? { outcome: stored } : stored

        if (result.outcome === 'failed') {
          return {
            node: peer.name,
            peerId: peer.peerId,
            ok: false,
            staged: result.staged,
            error: result.error ?? 'Replication store failed'
          }
        }

        return {
          node: peer.name,
          peerId: peer.peerId,
          ok: true,
          outcome: result.outcome,
          staged: result.staged
        }
      } catch (err) {
        return { node: peer.name, peerId: peer.peerId, ok: false, error: (err as Error).message }
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

  // Nobody took responsibility, which is what a node its peers have not been
  // configured with gets. Its file now rests on copies that may be reclaimed at
  // any time, so it is spread wider to make up for how little each one promises.
  if (replicas.length === 0 && cached.length > 0 && options.cacheOnly !== undefined) {
    const tried = new Set(targets.map((peer) => peer.peerId))
    const ranked = rankHolders(
      cid,
      peers.map((peer) => peer.peerId)
    )
    const extra = ranked
      .filter((peerId) => !tried.has(peerId))
      .slice(0, CACHE_WIDENING)
      .map((peerId) => peers.find((peer) => peer.peerId === peerId))
      .filter((peer): peer is ReplicationPeer => peer !== undefined)

    const widened = await Promise.all(
      extra.map(async (peer): Promise<ReplicationAck> => {
        try {
          await options.cacheOnly?.(peer, cid)
          return { node: peer.name, peerId: peer.peerId, ok: true, outcome: 'cached' }
        } catch (err) {
          return { node: peer.name, peerId: peer.peerId, ok: false, error: (err as Error).message }
        }
      })
    )

    attempts.push(...widened)
    cached.push(
      ...widened.filter((attempt) => attempt.outcome === 'cached').map((attempt) => attempt.node)
    )
  }

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
