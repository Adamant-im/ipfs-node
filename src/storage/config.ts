const MiB = 1024 * 1024
const GiB = 1024 * MiB

/**
 * Garbage collection thresholds, expressed in blockstore bytes.
 *
 * Collection starts once the blockstore grows above `highWatermarkBytes` and
 * keeps reclaiming until it drops below `lowWatermarkBytes`. The gap between
 * the two stops the collector from running on every tick near one threshold.
 */
export interface GarbageCollectionConfig {
  /** Whether the scheduled collector runs. The admin endpoint works regardless. */
  enabled: boolean
  /** Collection schedule in cron format. */
  schedule: string
  highWatermarkBytes: number
  lowWatermarkBytes: number
}

export interface StorageConfig {
  /** Maximum combined size of all files accepted in a single upload request. */
  maxRequestSizeBytes: number
  /** Maximum number of upload requests writing into the blockstore at once. */
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
  /** When false the node stores content best effort and never contacts peers. */
  enabled: boolean
  /** Number of ADAMANT nodes that must hold a copy, including this node. */
  factor: number
  /** Acknowledgements required before an upload is reported as durable. */
  ackQuorum: number
  /** When true an upload fails unless the acknowledgement quorum is reached. */
  requireQuorumOnUpload: boolean
  /** Timeout of a single replication request to a peer node. */
  requestTimeoutMs: number
  repairEnabled: boolean
  repairSchedule: string
  /**
   * Secret shared by the ADAMANT nodes, sent as `x-replication-token`.
   *
   * It is deliberately separate from `adminApiKey`: a peer only needs to ask
   * this node to store a copy, so distributing the administrative key across
   * the node set would grant far more than replication requires.
   *
   * Setting it opens the replication intake route, independently of `enabled`,
   * so a node can accept copies without pushing any of its own.
   */
  token: string
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  maxRequestSizeBytes: 512 * MiB,
  maxConcurrentUploads: 4,
  diskReserveBytes: 5 * GiB,
  confirmationRequired: false,
  temporaryTtlMs: 24 * 60 * 60 * 1000,
  gc: {
    enabled: false,
    schedule: '0 */15 * * * *',
    highWatermarkBytes: 50 * GiB,
    lowWatermarkBytes: 40 * GiB
  }
}

export const DEFAULT_REPLICATION_CONFIG: ReplicationConfig = {
  enabled: false,
  factor: 2,
  ackQuorum: 1,
  requireQuorumOnUpload: false,
  requestTimeoutMs: 30000,
  repairEnabled: true,
  repairSchedule: '0 */30 * * * *',
  token: ''
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
 * Resolve the `replication` section.
 *
 * @param raw Value of the `replication` key from a parsed config file
 */
export function resolveReplicationConfig(raw: unknown): ReplicationConfig {
  const input = section(raw, 'replication')
  const defaults = DEFAULT_REPLICATION_CONFIG

  const replication: ReplicationConfig = {
    enabled: optionalBoolean(input.enabled, 'replication.enabled', defaults.enabled),
    factor: optionalInteger(input.factor, 'replication.factor', defaults.factor, 1),
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
    ),
    token: optionalString(input.token, 'replication.token', defaults.token)
  }

  if (replication.ackQuorum > replication.factor) {
    fail('replication.ackQuorum', 'must not exceed replication.factor')
  }

  if (replication.enabled && replication.token === '') {
    fail('replication.token', 'must be set when replication is enabled')
  }

  // A node that only accepts copies leaves `enabled` false but still needs the
  // token, so the strength requirement applies whenever one is configured.
  if (replication.token !== '' && replication.token.length < 32) {
    fail('replication.token', 'must be a secret of at least 32 characters')
  }

  return replication
}
