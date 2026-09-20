import { peerIdFromString } from '@libp2p/peer-id'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'
import { resetPeerConnection } from './liveness.js'

/** Do not reset the same peer more than once in this window. */
const RECOVERY_COOLDOWN_MS = 30_000

const lastRecoveryAt = new Map<string, number>()

/**
 * Patterns that indicate the libp2p session is stale while TCP may still look up.
 */
export function isStalePeerSessionError(message: string): boolean {
  return (
    message.includes('stream that is closed') ||
    message.includes('stream ended before') ||
    message.includes('Replication request timed out') ||
    message.includes('The connection is closed')
  )
}

/**
 * Drop connections to a configured peer and schedule an immediate peering pass.
 *
 * @param peerId Configured peer identifier string
 * @param reason Logged context for operators
 * @param redial Peering function injected to avoid import cycles in tests
 */
export function recoverPeerSession(
  peerId: string,
  reason: string,
  redial: () => Promise<number>
): void {
  const now = Date.now()
  const last = lastRecoveryAt.get(peerId) ?? 0

  if (now - last < RECOVERY_COOLDOWN_MS) {
    return
  }

  lastRecoveryAt.set(peerId, now)

  void (async () => {
    try {
      logger.warn(
        { event: 'peer_session_recovery', peerId, reason },
        'Resetting libp2p session to a configured peer after a transfer failure'
      )
      await resetPeerConnection(helia, peerIdFromString(peerId))
      await redial()
    } catch (err) {
      logger.error({ err, peerId }, 'Peer session recovery failed')
    }
  })()
}
