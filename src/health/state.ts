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
  /** Time this response was produced. */
  timestamp: number
  /**
   * Time the checkpoint attempt behind this snapshot ran.
   *
   * A failed attempt leaves `checkpoint.observedAt` on the last successful
   * round while `membership`, `startup`, and the non-age checks come from the
   * attempt that just failed, so those fields are dated by this value and not
   * by `checkpoint.observedAt`.
   */
  evaluatedAt: number
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
    checkpointFresh: boolean
    /** The clock has not moved behind the checkpoint this node already recorded. */
    clockConsistent: boolean
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
  const prerequisiteChecks = {
    // A clock behind the last checkpoint would keep the old height through
    // `Math.max` while stamping a lower `completedAt`, persisting a round that
    // starts after it finished — the shape `parseCheckpoint` refuses to load.
    // Advancement waits for the clock instead of recording that.
    clockConsistent: input.previous === null || input.previous.completedAt <= input.now,
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
        // A completion stamped ahead of the clock is not evidence of freshness;
        // without the lower bound its negative age would always pass.
        input.now >= input.repairCompletedAt &&
        input.now - input.repairCompletedAt <= policy.repairMaxAgeMs),
    peerAttestations: input.attestedPeers >= policy.requiredPeerCount
  }
  const complete = Object.values(prerequisiteChecks).every(Boolean)
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
  const checkpointObservedAt = completed?.completedAt ?? input.previous?.completedAt ?? null
  const checks = {
    checkpointFresh:
      checkpointObservedAt !== null &&
      input.now - checkpointObservedAt <= policy.maxCheckpointAgeMs,
    ...prerequisiteChecks
  }

  return {
    snapshot: {
      state,
      height: completed?.height ?? input.previous?.height ?? 0,
      timestamp: input.now,
      evaluatedAt: input.now,
      checkpoint: {
        intervalMs: policy.checkpointIntervalMs,
        observedAt: checkpointObservedAt,
        ageMs: age(input.now, checkpointObservedAt),
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

/** Refresh elapsed ages and freshness checks without performing checkpoint I/O. */
export function refreshHealthSnapshot(
  current: HealthSnapshot,
  timestamp: number,
  policy: Pick<HealthConfig, 'storageMaxAgeMs' | 'repairMaxAgeMs'>
): HealthSnapshot {
  const checkpointAge = age(timestamp, current.checkpoint.observedAt)
  const storageAge = age(timestamp, current.storage.measuredAt)
  const repairAge = age(timestamp, current.replication.lastCompleteAt)

  // `age` clamps a negative duration to zero, so a clock behind the evidence in
  // this snapshot would read as brand new rather than as impossible. Each
  // observation is compared against the request time explicitly instead, and the
  // endpoint fails safe on the first read after a rollback rather than waiting
  // for the next scheduled evaluation.
  const notInFuture = (observedAt: number | null): boolean =>
    observedAt === null || timestamp >= observedAt
  const clockConsistent =
    current.checks.clockConsistent &&
    notInFuture(current.checkpoint.observedAt) &&
    notInFuture(current.storage.measuredAt) &&
    notInFuture(current.replication.lastCompleteAt)

  const checks = {
    ...current.checks,
    clockConsistent,
    checkpointFresh:
      clockConsistent && checkpointAge !== null && checkpointAge <= current.checkpoint.maxAgeMs,
    storageFresh:
      current.checks.storageFresh &&
      clockConsistent &&
      storageAge !== null &&
      storageAge <= policy.storageMaxAgeMs,
    repairFresh:
      !current.replication.repairRequired ||
      (current.checks.repairFresh &&
        clockConsistent &&
        current.replication.backlog === 0 &&
        repairAge !== null &&
        repairAge <= policy.repairMaxAgeMs)
  }
  const freshnessFailed = !checks.clockConsistent || !checks.storageFresh || !checks.repairFresh

  return {
    ...current,
    state:
      current.state !== 'starting' &&
      checkpointAge !== null &&
      checkpointAge > current.checkpoint.maxAgeMs
        ? 'stale'
        : current.state === 'ready' && freshnessFailed
          ? 'degraded'
          : current.state,
    timestamp,
    checkpoint: {
      ...current.checkpoint,
      ageMs: checkpointAge
    },
    storage: {
      ...current.storage,
      measurementAgeMs: storageAge
    },
    replication: {
      ...current.replication,
      ageMs: repairAge
    },
    checks
  }
}
