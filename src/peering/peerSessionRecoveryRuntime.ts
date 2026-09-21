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
import { REPLICATION_PROTOCOL } from '../storage/replicationProtocol.js'

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
 *
 * Ping is diagnostic only and never vetoes resetting an application session
 * whose replication or transfer stream failed.
 */
export async function recoverPeerSession(
  peerId: string,
  reason: string,
  protocol: string = REPLICATION_PROTOCOL
): Promise<boolean> {
  const actions = defaultRecoveryActions()

  let pingAnswered = false
  const recovered = await recoverPeerSessionCore(peerId, reason, {
    ...actions,
    ping: async (peerId) => {
      const alive = await actions.ping?.(peerId)
      pingAnswered = Boolean(alive)
      return pingAnswered
    },
    reset: async (peerId) => {
      logger.warn(
        {
          event: 'peer_session_recovery',
          peerId,
          protocol,
          reason,
          pingAnswered,
          vetoUsed: false
        },
        'Resetting libp2p session to a configured peer after a transfer failure'
      )
      await actions.reset(peerId)
    }
  })

  if (recovered) {
    logger.info(
      { event: 'peer_session_recovered', peerId, protocol },
      'Successfully recovered libp2p session to a configured peer'
    )
  }

  return recovered
}
