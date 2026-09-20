import type { PeerId } from '@libp2p/interface'
import type { IpfsNode } from '../ipfs-node.js'
import { pingPeer, resetPeerConnection } from './liveness.js'

/**
 * Ping configured peers that appear connected and reset any that fail the ping.
 *
 * @returns Peer IDs whose connections were reset
 */
export async function dropUnhealthyConnectedPeers(
  node: IpfsNode,
  knownPeerIds: PeerId[],
  connectedPeerIds: Set<string>
): Promise<string[]> {
  const resetPeerIds: string[] = []

  await Promise.all(
    knownPeerIds
      .filter((peerId) => connectedPeerIds.has(peerId.toString()))
      .map(async (peerId) => {
        const alive = await pingPeer(node, peerId)

        if (alive) {
          return
        }

        await resetPeerConnection(node, peerId)
        resetPeerIds.push(peerId.toString())
      })
  )

  return resetPeerIds
}
