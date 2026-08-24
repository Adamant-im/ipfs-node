import type { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'
import type { ReplicationConfig } from './config.js'
import { rankHolders } from './placement.js'
import type { ReplicationPeer } from './replication.js'

/**
 * Time allowed for opening connections to a file's holders before retrieval
 * starts. Short on purpose: a peer that cannot be reached quickly is not worth
 * waiting for when others may already be connected.
 */
export const HOLDER_DIAL_TIMEOUT_MS = 5000

/**
 * The nodes worth asking for a CID this node does not hold.
 *
 * The holders of a file are a prefix of its rendezvous ranking, and the ranking
 * does not depend on age — only how much of it is used does. Taking the largest
 * prefix any tier can ask for therefore covers the holders of a file of any
 * age, without knowing when it was uploaded. That matters here, because a node
 * asked for a file it never stored has no record of it.
 *
 * With replication disabled there are no designated holders, so every known
 * node is a candidate.
 */
export function retrievalTargets(
  cid: string,
  config: ReplicationConfig,
  selfPeerId: string,
  peers: ReplicationPeer[]
): ReplicationPeer[] {
  if (!config.enabled) {
    return peers
  }

  const widest = Math.max(...config.placement.map((tier) => tier.copies))
  const ranked = rankHolders(cid, [selfPeerId, ...peers.map((peer) => peer.peerId)]).slice(
    0,
    widest
  )
  const wanted = new Set(ranked)

  return peers.filter((peer) => wanted.has(peer.peerId))
}

/**
 * Open connections to the nodes that should hold `cid`.
 *
 * Without this, retrieval relies on the file being reachable through whichever
 * peers happen to be connected. That holds while every node is connected to
 * every other, and stops holding as soon as the network outgrows it: bitswap
 * asks the peers it has, and a node that is connected to none of the holders
 * waits for the retrieval timeout and answers `408`.
 *
 * Failures are ignored. This is a best-effort warm-up before retrieval, and a
 * peer that is already connected, unreachable, or slow must not delay the read.
 */
export async function connectToHolders(
  node: IpfsNode,
  targets: ReplicationPeer[],
  timeoutMs: number = HOLDER_DIAL_TIMEOUT_MS
): Promise<number> {
  const connected = new Set(node.libp2p.getPeers().map((peer) => peer.toString()))
  const missing = targets.filter((peer) => !connected.has(peer.peerId))

  if (missing.length === 0) {
    return 0
  }

  const results = await Promise.allSettled(
    missing.map(async (peer) =>
      node.libp2p.dial(peer.multiAddr, { signal: AbortSignal.timeout(timeoutMs) })
    )
  )

  return results.filter((result) => result.status === 'fulfilled').length
}

/**
 * Make sure a CID can be retrieved before asking for it.
 *
 * Does nothing when the block is already here, which is the common case for a
 * designated holder and costs one blockstore lookup for everyone else.
 */
export async function prepareRetrieval(
  node: IpfsNode,
  cid: CID,
  targets: () => ReplicationPeer[],
  timeoutMs: number = HOLDER_DIAL_TIMEOUT_MS
): Promise<void> {
  if (await node.blockstore.has(cid)) {
    return
  }

  await connectToHolders(node, targets(), timeoutMs)
}
