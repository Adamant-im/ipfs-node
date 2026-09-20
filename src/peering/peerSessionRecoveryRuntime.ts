import { peerIdFromString } from '@libp2p/peer-id'
import { helia } from '../helia.js'
import { getNodesList } from '../utils/utils.js'
import { logger } from '../utils/logger.js'
import { pingPeer, resetPeerConnection } from './liveness.js'
import { redialKnownPeer } from './redialKnownPeer.js'
import {
  recoverPeerSession as recoverPeerSessionCore,
  type PeerSessionRecoveryActions
} from './peerSessionRecovery.js'

function defaultRecoveryActions(): PeerSessionRecoveryActions {
  const selfPeerId = helia.libp2p.peerId.toString()

  return {
    isConfiguredPeer: (peerId) =>
      getNodesList([selfPeerId]).some((node) => node.peerId.toString() === peerId),
    ping: async (peerId) => pingPeer(helia, peerIdFromString(peerId)),
    reset: async (peerId) => resetPeerConnection(helia, peerIdFromString(peerId)),
    redial: redialKnownPeer,
    now: Date.now
  }
}

/**
 * Reset a configured peer session when reactive recovery is warranted.
 */
export function recoverPeerSession(peerId: string, reason: string): void {
  const actions = defaultRecoveryActions()

  recoverPeerSessionCore(peerId, reason, {
    ...actions,
    ping: async (peerId) => {
      const alive = await actions.ping(peerId)

      if (alive) {
        logger.info(
          { event: 'peer_session_recovery_skipped', peerId, reason },
          'Peer answered a liveness ping; keeping the existing libp2p session'
        )
      }

      return alive
    },
    reset: async (peerId) => {
      logger.warn(
        { event: 'peer_session_recovery', peerId, reason },
        'Resetting libp2p session to a configured peer after a transfer failure'
      )
      await actions.reset(peerId)
    }
  })
}
