import type { PlacementTier } from './placement.js'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const DAY = 24 * 60 * 60 * 1000

/**
 * Garbage collection thresholds, expressed in blockstore bytes.
 *
 * Collection starts once the blockstore grows above `highWatermarkBytes` and
 * keeps reclaiming until it drops below `lowWatermarkBytes`. The gap between
 * the two stops the collector from running on every tick near one threshold.
 */
export interface GarbageCollectionConfig {
  /**
   * Whether the scheduled collector runs. The admin endpoint works regardless.
   *
   * The collector frees blocks only when space is short: after the blockstore
   * passes `highWatermarkBytes` or free space falls into
   * `storage.diskReserveBytes`.
   */
  enabled: boolean
  /** Collection schedule in cron format. */
  schedule: string
  highWatermarkBytes: number
  lowWatermarkBytes: number
}

export interface StorageConfig {
  /** Maximum combined size of all files accepted in a single upload request. */
  maxRequestSizeBytes: number
  /**
   * Maximum number of upload requests writing into the blockstore at once.
   *
   * A saturation backstop rather than the disk guard: every request claims the
   * bytes it may write against `diskReserveBytes` atomically, so space is
   * already bounded without this. What is left for this limit is keeping a node
   * from opening more concurrent writers than it can serve.
   *
   * Several clients uploading to the same node at the same time is ordinary
   * traffic rather than a burst, so it sits well above what fairness alone
   * would ask for: a limit low enough to be reached by normal use turns into
   * `429` for a person who did nothing wrong.
   */
  maxConcurrentUploads: number
  /** Free space on the blockstore filesystem that uploads must never consume. */
  diskReserveBytes: number
  /** When true, an upload stays temporary until an authorized confirmation. */
  confirmationRequired: boolean
  /** Lifetime of an unconfirmed upload before it becomes reclaimable. */
  temporaryTtlMs: number
  gc: GarbageCollectionConfig
}

export interface ReplicationConfig {
  /**
   * Whether this node places copies of its own content on its peers.
   *
   * Answering a peer that wants to place a copy here does not depend on it: a
   * node that only accepted copies while it was also sending them could not
   * join a network without every other node being reconfigured first.
   *
   * When false the node stores content best effort and never contacts peers.
   */
  enabled: boolean
  /**
   * How many nodes should hold a file, including this one, by file age.
   *
   * Copies are reduced as content ages instead of being tracked by access time,
   * which would record when users fetch their files.
   */
  placement: PlacementTier[]
  /** Acknowledgements required before an upload is reported as durable, including this node. */
  ackQuorum: number
  /**
   * When true an upload fails unless the acknowledgement quorum is reached.
   *
   * Requires `ackQuorum >= 2` so a remote copy is part of the decision, and
   * cannot be combined with `storage.confirmationRequired`.
   */
  requireQuorumOnUpload: boolean
  /** Timeout of a single replication request to a peer node. */
  requestTimeoutMs: number
  repairEnabled: boolean
  repairSchedule: string
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  maxRequestSizeBytes: 512 * MiB,
  maxConcurrentUploads: 32,
  diskReserveBytes: 5 * GiB,
  confirmationRequired: false,
  temporaryTtlMs: 24 * 60 * 60 * 1000,
  gc: {
    enabled: true,
    schedule: '0 */15 * * * *',
    highWatermarkBytes: 50 * GiB,
    lowWatermarkBytes: 40 * GiB
  }
}

export const DEFAULT_REPLICATION_CONFIG: ReplicationConfig = {
  enabled: true,
  placement: [
    { minAgeMs: 0, copies: 4 },
    { minAgeMs: 180 * DAY, copies: 3 },
    { minAgeMs: 365 * DAY, copies: 2 }
  ],
  ackQuorum: 1,
  requireQuorumOnUpload: false,
  requestTimeoutMs: 30000,
  repairEnabled: true,
  repairSchedule: '0 */30 * * * *'
}

function fail(path: string, expectation: string): never {
  throw new Error(`Invalid config: "${path}" ${expectation}`)
}

function section(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    fail(path, 'must be a boolean')
  }
  return value
}

function optionalString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'string') {
    fail(path, 'must be a string')
  }
  return value
}

/**
 * Validate an optional integer option.
 *
 * @param min Smallest accepted value, used to reject limits that would disable a guarantee
 */
function optionalInteger(value: unknown, path: string, fallback: number, min: number): number {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(path, `must be an integer >= ${min}`)
  }
  return value
}

/**
 * Resolve the `storage` section, filling in defaults for every option the
 * operator did not set so that an existing config file keeps working.
 *
 * @param raw Value of the `storage` key from a parsed config file
 * @param uploadLimitSizeBytes Per-file limit, which the aggregate limit must cover
 */
export function resolveStorageConfig(raw: unknown, uploadLimitSizeBytes: number): StorageConfig {
  const input = section(raw, 'storage')
  const gcInput = section(input.gc, 'storage.gc')
  const defaults = DEFAULT_STORAGE_CONFIG

  const gc: GarbageCollectionConfig = {
    enabled: optionalBoolean(gcInput.enabled, 'storage.gc.enabled', defaults.gc.enabled),
    schedule: optionalString(gcInput.schedule, 'storage.gc.schedule', defaults.gc.schedule),
    highWatermarkBytes: optionalInteger(
      gcInput.highWatermarkBytes,
      'storage.gc.highWatermarkBytes',
      defaults.gc.highWatermarkBytes,
      1
    ),
    lowWatermarkBytes: optionalInteger(
      gcInput.lowWatermarkBytes,
      'storage.gc.lowWatermarkBytes',
      defaults.gc.lowWatermarkBytes,
      1
    )
  }

  if (gc.lowWatermarkBytes >= gc.highWatermarkBytes) {
    fail('storage.gc.lowWatermarkBytes', 'must be lower than storage.gc.highWatermarkBytes')
  }

  const storage: StorageConfig = {
    maxRequestSizeBytes: optionalInteger(
      input.maxRequestSizeBytes,
      'storage.maxRequestSizeBytes',
      defaults.maxRequestSizeBytes,
      1
    ),
    maxConcurrentUploads: optionalInteger(
      input.maxConcurrentUploads,
      'storage.maxConcurrentUploads',
      defaults.maxConcurrentUploads,
      1
    ),
    diskReserveBytes: optionalInteger(
      input.diskReserveBytes,
      'storage.diskReserveBytes',
      defaults.diskReserveBytes,
      0
    ),
    confirmationRequired: optionalBoolean(
      input.confirmationRequired,
      'storage.confirmationRequired',
      defaults.confirmationRequired
    ),
    temporaryTtlMs: optionalInteger(
      input.temporaryTtlMs,
      'storage.temporaryTtlMs',
      defaults.temporaryTtlMs,
      1
    ),
    gc
  }

  if (storage.maxRequestSizeBytes < uploadLimitSizeBytes) {
    fail(
      'storage.maxRequestSizeBytes',
      'must be greater than or equal to uploadLimitSizeBytes, otherwise no single file can be uploaded'
    )
  }

  return storage
}

/**
 * Validate the placement tiers.
 *
 * The tiers must start at age zero and never go backwards, so that exactly one
 * of them applies to any file and every node reaches the same answer.
 */
function resolvePlacement(raw: unknown, defaults: PlacementTier[]): PlacementTier[] {
  if (raw === undefined) {
    return defaults.map((tier) => ({ ...tier }))
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    fail('replication.placement', 'must be a non-empty array of tiers')
  }

  const tiers = raw.map((entry, index) => {
    const path = `replication.placement[${index}]`
    const tier = section(entry, path)

    return {
      minAgeMs: optionalInteger(tier.minAgeMs, `${path}.minAgeMs`, 0, 0),
      copies: optionalInteger(tier.copies, `${path}.copies`, 1, 1)
    }
  })

  if (tiers[0].minAgeMs !== 0) {
    fail('replication.placement[0].minAgeMs', 'must be 0 so that every file matches a tier')
  }

  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index].minAgeMs <= tiers[index - 1].minAgeMs) {
      fail(`replication.placement[${index}].minAgeMs`, 'must be greater than the previous tier')
    }
    if (tiers[index].copies > tiers[index - 1].copies) {
      fail(
        `replication.placement[${index}].copies`,
        'must not exceed the previous tier so copies shrink as a file ages'
      )
    }
  }

  return tiers
}

/**
 * Resolve the `replication` section.
 *
 * @param raw Value of the `replication` key from a parsed config file
 */
export function resolveReplicationConfig(raw: unknown): ReplicationConfig {
  const input = section(raw, 'replication')
  const defaults = DEFAULT_REPLICATION_CONFIG
  const placement = resolvePlacement(input.placement, defaults.placement)

  const replication: ReplicationConfig = {
    enabled: optionalBoolean(input.enabled, 'replication.enabled', defaults.enabled),
    placement,
    ackQuorum: optionalInteger(input.ackQuorum, 'replication.ackQuorum', defaults.ackQuorum, 1),
    requireQuorumOnUpload: optionalBoolean(
      input.requireQuorumOnUpload,
      'replication.requireQuorumOnUpload',
      defaults.requireQuorumOnUpload
    ),
    requestTimeoutMs: optionalInteger(
      input.requestTimeoutMs,
      'replication.requestTimeoutMs',
      defaults.requestTimeoutMs,
      1
    ),
    repairEnabled: optionalBoolean(
      input.repairEnabled,
      'replication.repairEnabled',
      defaults.repairEnabled
    ),
    repairSchedule: optionalString(
      input.repairSchedule,
      'replication.repairSchedule',
      defaults.repairSchedule
    )
  }

  const mostCopies = placement[0]?.copies ?? 0
  if (replication.ackQuorum > mostCopies) {
    fail(
      'replication.ackQuorum',
      'must not exceed the fresh-tier copy count in replication.placement'
    )
  }

  if (replication.requireQuorumOnUpload && replication.ackQuorum < 2) {
    fail(
      'replication.ackQuorum',
      'must be >= 2 when replication.requireQuorumOnUpload is true, so a strict upload cannot succeed with only the local copy'
    )
  }

  return replication
}
