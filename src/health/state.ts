import type { HealthConfig } from '../config.js'

export type HealthState = 'starting' | 'ready' | 'stale' | 'degraded'

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
  repairHealthy: boolean
  repairBacklog: number
  attestedPeers: number
  membershipVersion: string
  previous: HealthCheckpoint | null
}

export interface HealthSnapshot {
  state: HealthState
  /** Monotonic checkpoint height, never a request timestamp. */
  height: number
  timestamp: number
  checkpoint: {
    intervalMs: number
    observedAt: number | null
    ageMs: number | null
    maxAgeMs: number
  }
  membership: {
    version: string
    requiredPeers: number
    attestedPeers: number
  }
  startup: {
    complete: boolean
    healthy: boolean
  }
  storage: {
    measuredAt: number | null
    measurementAgeMs: number | null
    reserveHealthy: boolean
  }
  replication: {
    repairRequired: boolean
    lastCompleteAt: number | null
    ageMs: number | null
    backlog: number
  }
  checks: {
    helia: boolean
    startupReconciliation: boolean
    storageFresh: boolean
    storageReserve: boolean
    repairFresh: boolean
    peerAttestations: boolean
  }
}

function age(now: number, observedAt: number | null): number | null {
  return observedAt === null ? null : Math.max(0, now - observedAt)
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
      (input.repairHealthy &&
        input.repairBacklog === 0 &&
        input.repairCompletedAt !== null &&
        input.now - input.repairCompletedAt <= policy.repairMaxAgeMs),
    peerAttestations: input.attestedPeers >= policy.requiredPeerCount
  }
  const complete = Object.values(checks).every(Boolean)
  const previousAge = input.previous === null ? null : input.now - input.previous.completedAt
  const state: HealthState = complete
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
      state,
      height: completed?.height ?? input.previous?.height ?? 0,
      timestamp: input.now,
      checkpoint: {
        intervalMs: policy.checkpointIntervalMs,
        observedAt: completed?.completedAt ?? input.previous?.completedAt ?? null,
        ageMs: age(input.now, completed?.completedAt ?? input.previous?.completedAt ?? null),
        maxAgeMs: policy.maxCheckpointAgeMs
      },
      membership: {
        version: input.membershipVersion,
        requiredPeers: policy.requiredPeerCount,
        attestedPeers: input.attestedPeers
      },
      startup: {
        complete: input.startupComplete,
        healthy: input.startupHealthy
      },
      storage: {
        measuredAt: input.storageUpdatedAt,
        measurementAgeMs: age(input.now, input.storageUpdatedAt),
        reserveHealthy: checks.storageReserve
      },
      replication: {
        repairRequired: input.repairRequired,
        lastCompleteAt: input.repairCompletedAt,
        ageMs: age(input.now, input.repairCompletedAt),
        backlog: input.repairBacklog
      },
      checks
    },
    completed
  }
}

/** Refresh elapsed ages and stale state without performing checkpoint I/O. */
export function refreshHealthSnapshot(current: HealthSnapshot, timestamp: number): HealthSnapshot {
  const checkpointAge = age(timestamp, current.checkpoint.observedAt)

  return {
    ...current,
    state:
      current.state !== 'starting' &&
      checkpointAge !== null &&
      checkpointAge > current.checkpoint.maxAgeMs
        ? 'stale'
        : current.state,
    timestamp,
    checkpoint: {
      ...current.checkpoint,
      ageMs: checkpointAge
    },
    storage: {
      ...current.storage,
      measurementAgeMs: age(timestamp, current.storage.measuredAt)
    },
    replication: {
      ...current.replication,
      ageMs: age(timestamp, current.replication.lastCompleteAt)
    }
  }
}
