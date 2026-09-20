import { CronJob } from 'cron'
import { config } from './config.js'
import { helia } from './helia.js'
import { pingPeer, resetPeerConnection } from './peering/liveness.js'
import { logger } from './utils/logger.js'
import { getNodesList } from './utils/utils.js'

/**
 * Time allowed for one peering dial. A node that is down must not hold up the
 * others, and the next tick will try it again.
 */
const DIAL_TIMEOUT_MS = 10000

let running = false
let lastConnected = 0

/**
 * Ping configured peers that appear connected and reset any that do not answer.
 *
 * `@libp2p/bootstrap` only runs once; peering already redials missing peers.
 * That is not enough when TCP stays up but bitswap or replication streams are
 * broken — those peers never count as "missing".
 */
async function dropUnhealthyKnownPeers(): Promise<void> {
  const known = getNodesList([helia.libp2p.peerId.toString()])
  const connected = new Set(helia.libp2p.getPeers().map((peer) => peer.toString()))

  await Promise.all(
    known
      .filter((node) => connected.has(node.peerId.toString()))
      .map(async (node) => {
        const alive = await pingPeer(helia, node.peerId)

        if (alive) {
          return
        }

        logger.warn(
          { event: 'peering_liveness_failed', peer: node.name },
          `Peering liveness check failed for ${node.name}; resetting connection`
        )
        await resetPeerConnection(helia, node.peerId)
      })
  )
}

/**
 * Dial the configured ADAMANT nodes that are not currently connected.
 *
 * `@libp2p/bootstrap` emits its peers once shortly after start and never again,
 * so nothing reconnects a peer that restarted or dropped. A mesh that quietly
 * comes apart still serves uploads, which makes the failure easy to miss: it
 * shows up later as slow retrieval and as replication that cannot place copies.
 *
 * The work is bounded by the size of `nodes`, which is the operator's own peer
 * list, so this never turns into network-wide dialling.
 *
 * @returns How many nodes are connected after this pass
 */
export async function peerWithKnownNodes(): Promise<number> {
  await dropUnhealthyKnownPeers()

  const known = getNodesList([helia.libp2p.peerId.toString()])
  const connected = new Set(helia.libp2p.getPeers().map((peer) => peer.toString()))
  const missing = known.filter((node) => !connected.has(node.peerId.toString()))

  const results = await Promise.allSettled(
    missing.map(async (node) => {
      await helia.libp2p.dial(node.multiAddr, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) })
      return node.name
    })
  )

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.debug(`Peering with ${missing[index].name} failed: ${String(result.reason)}`)
    }
  }

  lastConnected = helia.libp2p.getPeers().filter((peer) =>
    known.some((node) => node.peerId.equals(peer))
  ).length

  return lastConnected
}

export const peeringCron = new CronJob(config.peeringSchedule, () => {
  if (running) {
    return
  }

  running = true
  peerWithKnownNodes()
    .catch((err: Error) => logger.error({ err }, 'Peering cycle failed'))
    .finally(() => (running = false))
})

export function getPeeringState() {
  return {
    schedule: config.peeringSchedule,
    knownNodes: getNodesList([helia.libp2p.peerId.toString()]).length,
    connectedNodes: lastConnected
  }
}
