import { CronJob } from 'cron'
import { config } from './config.js'
import { helia } from './helia.js'
import { dropUnhealthyConnectedPeers } from './peering/dropUnhealthyPeers.js'
import { createInFlightPass } from './peering/inFlightPass.js'
import { PEER_DIAL_TIMEOUT_MS } from './peering/liveness.js'
import { logger } from './utils/logger.js'
import { getNodesList } from './utils/utils.js'

let running = false
let lastConnected = 0

/**
 * Ping configured peers that appear connected and reset any that do not answer.
 *
 * `@libp2p/bootstrap` only runs once; peering already redials missing peers.
 * That is not enough when TCP stays up but the session is otherwise dead —
 * those peers never count as "missing". Ping is a cheap liveness signal, not
 * proof that bitswap or replication on that session still work.
 */
async function dropUnhealthyKnownPeers(): Promise<void> {
  const known = getNodesList([helia.libp2p.peerId.toString()])
  const connected = new Set(helia.libp2p.getPeers().map((peer) => peer.toString()))
  const resetPeerIds = await dropUnhealthyConnectedPeers(
    helia,
    known.map((node) => node.peerId),
    connected
  )

  for (const peerId of resetPeerIds) {
    const node = known.find((entry) => entry.peerId.toString() === peerId)

    logger.warn(
      { event: 'peering_liveness_failed', peer: node?.name ?? peerId },
      `Peering liveness check failed for ${node?.name ?? peerId}; resetting connection`
    )
  }
}

const runPeeringPass = createInFlightPass<number>()

async function executePeeringPass(): Promise<number> {
  await dropUnhealthyKnownPeers()

  const known = getNodesList([helia.libp2p.peerId.toString()])
  const connected = new Set(helia.libp2p.getPeers().map((peer) => peer.toString()))
  const missing = known.filter((node) => !connected.has(node.peerId.toString()))

  const results = await Promise.allSettled(
    missing.map(async (node) => {
      await helia.libp2p.dial(node.multiAddr, { signal: AbortSignal.timeout(PEER_DIAL_TIMEOUT_MS) })
      return node.name
    })
  )

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.debug(`Peering with ${missing[index].name} failed: ${String(result.reason)}`)
    }
  }

  lastConnected = helia.libp2p
    .getPeers()
    .filter((peer) => known.some((node) => node.peerId.equals(peer))).length

  return lastConnected
}

/**
 * Keep configured peers connected: reset sessions that miss a ping, then dial
 * any that are not connected.
 *
 * `@libp2p/bootstrap` emits its peers once shortly after start and never again,
 * so nothing reconnects a peer that restarted or dropped. A mesh that quietly
 * comes apart still serves uploads, which makes the failure easy to miss: it
 * shows up later as slow retrieval and as replication that cannot place copies.
 * Connected peers that no longer answer ping have the same symptom, and they
 * never count as missing, so this pass pings them first.
 *
 * Ping is a cheap liveness signal, not proof that bitswap or replication on
 * that session still work.
 *
 * Concurrent callers share one in-flight pass instead of running duplicate
 * sweeps. The work is bounded by the size of `nodes`, which is the operator's
 * own peer list, so this never turns into network-wide dialling.
 *
 * @returns How many configured nodes are connected after this pass
 */
export async function peerWithKnownNodes(): Promise<number> {
  return runPeeringPass(executePeeringPass)
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
