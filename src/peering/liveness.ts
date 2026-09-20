import type { PeerId } from '@libp2p/interface'
import type { IpfsNode } from '../ipfs-node.js'

/** Time allowed for a libp2p ping that checks an existing mesh connection. */
export const PEER_PING_TIMEOUT_MS = 5000

/**
 * Time allowed for one peering dial. A node that is down must not hold up the
 * others, and the next tick will try it again.
 */
export const PEER_DIAL_TIMEOUT_MS = 10_000

/**
 * Return whether `peerId` answers a libp2p ping within the timeout.
 *
 * Ping is a cheap liveness signal, not proof that bitswap or replication on
 * the same session still work. A TCP session can stay up while those
 * application protocols are broken; a session that still answers ping is left
 * in place.
 */
export async function pingPeer(
  node: IpfsNode,
  peerId: PeerId,
  timeoutMs: number = PEER_PING_TIMEOUT_MS
): Promise<boolean> {
  try {
    await node.libp2p.services.ping.ping(peerId, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return true
  } catch {
    return false
  }
}

/**
 * Tear down every open libp2p connection to `peerId` so the next peering pass
 * dials a fresh session.
 */
export async function resetPeerConnection(node: IpfsNode, peerId: PeerId): Promise<void> {
  await node.libp2p.hangUp(peerId).catch(() => {})
}
