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
 * Time allowed for libp2p to clear a hung-up peer from its connected peers list.
 * 1,000 ms is sufficient for local yamux muxer teardown while bounding batch delays.
 */
export const PEER_HANG_UP_TIMEOUT_MS = 1_000

const inFlightPings = new Map<string, Promise<boolean>>()

/** Clear in-flight ping cache between unit tests. */
export function resetInFlightPingsForTests(): void {
  inFlightPings.clear()
}

/**
 * Return whether `peerId` answers a libp2p ping within the timeout.
 *
 * Concurrent ping calls to the same peer share one in-flight probe to prevent
 * stream collisions. Ping remains a cheap scheduled liveness probe, not proof
 * that bitswap or replication on the same session still work.
 */
export async function pingPeer(
  node: IpfsNode,
  peerId: PeerId,
  timeoutMs: number = PEER_PING_TIMEOUT_MS
): Promise<boolean> {
  const key = peerId.toString()
  const existing = inFlightPings.get(key)
  if (existing !== undefined) {
    return existing
  }

  const promise = (async () => {
    try {
      await node.libp2p.services.ping.ping(peerId, {
        signal: AbortSignal.timeout(timeoutMs)
      })
      return true
    } catch {
      return false
    } finally {
      inFlightPings.delete(key)
    }
  })()

  inFlightPings.set(key, promise)
  return promise
}

/**
 * Tear down every open libp2p connection to `peerId` and wait until libp2p no
 * longer reports the peer as connected, so the subsequent dial establishes a
 * genuinely fresh session.
 */
export async function resetPeerConnection(
  node: IpfsNode,
  peerId: PeerId,
  timeoutMs: number = PEER_HANG_UP_TIMEOUT_MS
): Promise<void> {
  await node.libp2p.hangUp(peerId).catch(() => {})

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const peers = node.libp2p.getPeers?.()
    if (!peers || !peers.some((p) => p.equals?.(peerId) || p.toString() === peerId.toString())) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
