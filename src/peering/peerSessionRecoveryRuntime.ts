import { peerIdFromString } from '@libp2p/peer-id'
import { helia } from '../helia.js'
import { getNodesList } from '../utils/utils.js'
import { logger } from '../utils/logger.js'
import { resetPeerConnection } from './liveness.js'
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
    reset: async (peerId) => resetPeerConnection(helia, peerIdFromString(peerId)),
    redial: redialKnownPeer,
    now: Date.now
  }
}

/**
 * Reset a configured peer session when reactive recovery is warranted.
 *
 * Hang-up is immediate: ping stays on the scheduled peering pass and does not
 * run here, because a live ping does not mean replication still works.
 */
export async function recoverPeerSession(
  peerId: string,
  reason: string,
  protocol: string = REPLICATION_PROTOCOL
): Promise<boolean> {
  const actions = defaultRecoveryActions()

  const recovered = await recoverPeerSessionCore(peerId, reason, {
    ...actions,
    reset: async (peerId) => {
      logger.warn(
        {
          event: 'peer_session_recovery',
          peerId,
          protocol,
          reason,
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
