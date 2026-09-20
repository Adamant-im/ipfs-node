import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'
import { getNodesList } from '../utils/utils.js'
import { PEER_DIAL_TIMEOUT_MS } from './liveness.js'

/**
 * Redial one configured peer after reactive session recovery.
 */
export async function redialKnownPeer(peerId: string): Promise<void> {
  const known = getNodesList([helia.libp2p.peerId.toString()])
  const node = known.find((entry) => entry.peerId.toString() === peerId)

  if (node === undefined) {
    return
  }

  try {
    await helia.libp2p.dial(node.multiAddr, { signal: AbortSignal.timeout(PEER_DIAL_TIMEOUT_MS) })
  } catch (err) {
    logger.debug(`Reactive redial to ${node.name} failed: ${String(err)}`)
  }
}
