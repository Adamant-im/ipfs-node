import type { HealthConfig } from '../config.js'

export type HealthStatus = 'starting' | 'ready' | 'stale' | 'degraded'

export interface HealthCheckpoint {
  /** Unix milliseconds at the start of the validated fixed round. */
  height: number
  completedAt: number
  membershipVersion: string
  attestedPeers: number
}

export interface HealthInputs {
  now: number
  heliaReady: boolean
  startupComplete: boolean
  startupHealthy: boolean
  storageUpdatedAt: number | null
  storageAvailableBytes: number
  storageReservedBytes: number
  repairRequired: boolean
  repairCompletedAt: number | null
  attestedPeers: number
  membershipVersion: string
  previous: HealthCheckpoint | null
}

export interface HealthSnapshot {
  status: HealthStatus
  /** Monotonic checkpoint height, never a request timestamp. */
  height: number
  timestamp: number
  checkpointIntervalMs: number
  membershipVersion: string
  checks: {
    helia: boolean
    startupReconciliation: boolean
    storageFresh: boolean
    storageReserve: boolean
    repairFresh: boolean
    peerAttestations: boolean
  }
  peerAttestations: {
    required: number
    received: number
  }
}

/** Return the fixed checkpoint round containing `time`. */
export function checkpointRound(time: number, intervalMs: number): number {
  return Math.floor(time / intervalMs) * intervalMs
}

/**
 * Evaluate one checkpoint attempt without performing network or datastore I/O.
 *
 * A failed attempt freezes the previous height. This is the core compatibility
 * property used by clients: height only advances after every bounded check for
 * the same round succeeds.
 */
export function evaluateHealth(
  policy: HealthConfig,
  input: HealthInputs
): { snapshot: HealthSnapshot; completed?: HealthCheckpoint } {
  const checks = {
    helia: input.heliaReady,
    startupReconciliation: input.startupComplete && input.startupHealthy,
    storageFresh:
      input.storageUpdatedAt !== null &&
      input.now - input.storageUpdatedAt <= policy.storageMaxAgeMs,
    storageReserve: input.storageAvailableBytes >= input.storageReservedBytes,
    repairFresh:
      !input.repairRequired ||
      (input.repairCompletedAt !== null &&
        input.now - input.repairCompletedAt <= policy.repairMaxAgeMs),
    peerAttestations: input.attestedPeers >= policy.requiredPeerCount
  }
  const complete = Object.values(checks).every(Boolean)
  const previousAge = input.previous === null ? null : input.now - input.previous.completedAt
  const status: HealthStatus = complete
    ? 'ready'
    : !input.startupComplete
      ? 'starting'
      : previousAge !== null && previousAge > policy.maxCheckpointAgeMs
        ? 'stale'
        : 'degraded'
  const completed = complete
    ? {
        height: Math.max(
          input.previous?.height ?? 0,
          checkpointRound(input.now, policy.checkpointIntervalMs)
        ),
        completedAt: input.now,
        membershipVersion: input.membershipVersion,
        attestedPeers: input.attestedPeers
      }
    : undefined

  return {
    snapshot: {
      status,
      height: completed?.height ?? input.previous?.height ?? 0,
      timestamp: input.now,
      checkpointIntervalMs: policy.checkpointIntervalMs,
      membershipVersion: input.membershipVersion,
      checks,
      peerAttestations: {
        required: policy.requiredPeerCount,
        received: input.attestedPeers
      }
    },
    completed
  }
}
