import { config } from '../config.js'
import { helia } from '../helia.js'
import { datastore } from '../store.js'
import { getStorageMetrics } from '../storage/metrics.js'
import { getNodesList } from '../utils/utils.js'
import { logger } from '../utils/logger.js'
import { getRepairHealthEvidence } from '../replication.cron.js'
import { membershipVersion } from './membership.js'
import { loadHealthCheckpoint, saveHealthCheckpoint } from './persistence.js'
import { HEALTH_PROTOCOL, registerHealthProtocol, requestHealthAttestation } from './protocol.js'
import {
  checkpointRound,
  evaluateHealth,
  type HealthCheckpoint,
  type HealthSnapshot
} from './state.js'

const networkMembershipVersion = membershipVersion(config.nodes)
let previous: HealthCheckpoint | null = null
let startupComplete = false
let startupHealthy = false
let running = false
let rerunRequested = false
let timer: NodeJS.Timeout | undefined

let snapshot: HealthSnapshot = evaluateHealth(config.health, {
  now: Date.now(),
  heliaReady: false,
  startupComplete: false,
  startupHealthy: false,
  storageUpdatedAt: null,
  storageAvailableBytes: 0,
  storageReservedBytes: config.storage.diskReserveBytes,
  repairRequired: config.replication.enabled && config.replication.repairEnabled,
  repairCompletedAt: null,
  attestedPeers: 0,
  membershipVersion: networkMembershipVersion,
  previous: null
}).snapshot

async function countAttestations(now: number): Promise<number> {
  if (config.health.requiredPeerCount === 0) return 0

  const round = checkpointRound(now, config.health.checkpointIntervalMs)
  const peers = getNodesList([helia.libp2p.peerId.toString()])
  const answers = await Promise.all(
    peers.map(async (peer) => {
      try {
        await requestHealthAttestation(
          helia,
          peer.multiAddr,
          { round, timestamp: now, membershipVersion: networkMembershipVersion },
          {
            timeoutMs: config.health.peerAttestationTimeoutMs,
            clockSkewToleranceMs: config.health.clockSkewToleranceMs
          }
        )
        return true
      } catch (err) {
        logger.debug({ peer: peer.name, err }, 'Health attestation failed')
        return false
      }
    })
  )
  return answers.filter(Boolean).length
}

/** Run one bounded health checkpoint attempt. Overlapping attempts are skipped. */
export async function runHealthCheckpoint(): Promise<HealthSnapshot> {
  if (running) {
    rerunRequested = true
    return snapshot
  }
  running = true

  try {
    const now = Date.now()
    const [attestedPeers, repair] = await Promise.all([
      countAttestations(now),
      Promise.resolve(getRepairHealthEvidence())
    ])
    const storage = getStorageMetrics()
    const evaluated = evaluateHealth(config.health, {
      now,
      heliaReady: helia.libp2p.status === 'started',
      startupComplete,
      startupHealthy,
      storageUpdatedAt: storage.updatedAt,
      storageAvailableBytes: storage.availableBytes,
      storageReservedBytes: storage.reservedBytes,
      repairRequired: repair.required,
      repairCompletedAt: repair.completedAt,
      attestedPeers,
      membershipVersion: networkMembershipVersion,
      previous
    })

    if (evaluated.completed !== undefined) {
      await saveHealthCheckpoint(datastore, evaluated.completed)
      previous = evaluated.completed
    }
    snapshot = evaluated.snapshot

    logger.info(
      {
        event: 'health_checkpoint',
        status: snapshot.status,
        height: snapshot.height,
        checks: snapshot.checks,
        attestedPeers
      },
      'Health checkpoint evaluated'
    )
    return snapshot
  } finally {
    running = false
    if (rerunRequested) {
      rerunRequested = false
      scheduleCheckpoint()
    }
  }
}

function scheduleCheckpoint(): void {
  void runHealthCheckpoint().catch((err: Error) => {
    logger.error({ event: 'health_checkpoint_error', err }, 'Health checkpoint failed')
  })
}

/** Start the health protocol and the fixed-round checkpoint scheduler. */
export async function startHealthService(): Promise<void> {
  previous = await loadHealthCheckpoint(datastore)
  if (previous?.membershipVersion !== networkMembershipVersion) previous = null

  const authorizedPeerIds = new Set(
    getNodesList([helia.libp2p.peerId.toString()]).map((peer) => peer.peerId.toString())
  )
  await registerHealthProtocol(helia, {
    timeoutMs: config.health.peerAttestationTimeoutMs,
    checkpointIntervalMs: config.health.checkpointIntervalMs,
    clockSkewToleranceMs: config.health.clockSkewToleranceMs,
    membershipVersion: networkMembershipVersion,
    authorizedPeerIds,
    onError: (message) =>
      logger.warn({ protocol: HEALTH_PROTOCOL, message }, 'Health protocol error')
  })

  timer = setInterval(scheduleCheckpoint, config.health.checkpointIntervalMs)
  timer.unref()
  scheduleCheckpoint()
}

/** Mark startup reconciliation complete and immediately re-evaluate readiness. */
export function setStartupReconciliationResult(healthy: boolean): void {
  startupComplete = true
  startupHealthy = healthy
  scheduleCheckpoint()
}

/** Stop scheduling new health work during graceful shutdown. */
export function stopHealthService(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

/** Cached, read-only response for the always-200 health endpoint. */
export function getHealthSnapshot(): HealthSnapshot {
  return { ...snapshot, timestamp: Date.now() }
}
