import type { PeerId } from '@libp2p/interface'
import type { IpfsNode } from '../ipfs-node.js'

/** Time allowed for a libp2p ping that validates an existing mesh connection. */
export const PEER_PING_TIMEOUT_MS = 5000

/**
 * Return whether `peerId` answers a libp2p ping within the timeout.
 *
 * A TCP session can stay up while application protocols on it are broken; ping
 * exercises the same stream stack bitswap and replication rely on.
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
