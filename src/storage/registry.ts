import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Key } from 'interface-datastore'
import type { Datastore, Pair } from 'interface-datastore'

/**
 * Datastore namespace of the lifecycle registry.
 * It is kept separate from the Helia records stored in the same datastore.
 */
export const REGISTRY_PREFIX = '/adm/files'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Lifecycle state of a file known to this node. */
export type FileState = 'temporary' | 'confirmed' | 'expired'

/** Lifecycle state restored when a staged replica is abandoned. */
export interface ReplicaStageBaseline {
  state: 'expired'
  expiresAt: number | null
  confirmedAt: number | null
  pinned: false
  heldLocally: false
}

/** Durable compensation data for copies prepared for a strict upload. */
export interface ReplicaStage {
  /** Upload transactions that currently need this prepared copy. */
  transactionIds: string[]
  /** `null` when the stage created the registry entry. */
  previous: ReplicaStageBaseline | null
}

export interface FileRecord {
  cid: string
  name: string
  state: FileState
  /** Unix epoch milliseconds when the file entered the blockstore. */
  createdAt: number
  /** Unix epoch milliseconds after which a temporary file is reclaimable. */
  expiresAt: number | null
  confirmedAt: number | null
  /** Size reported by UnixFS for the file itself. */
  fileSize: number
  /** Bytes of blocks this node actually wrote for the file. */
  storedBytes: number
  /**
   * Deduplicated bytes in the file's DAG, whether or not they already existed.
   *
   * Optional for records written before this field was introduced. Callers
   * that need a protection estimate must use {@link protectedStorageBytes} so
   * those records remain usable after an in-place upgrade.
   */
  protectedBytes?: number
  /** True while the root CID is pinned and therefore protected from collection. */
  pinned: boolean
  /**
   * Whether this node is still one of the file's holders.
   *
   * A confirmed file whose copies live on other nodes is released here and
   * `heldLocally` becomes false. The record stays so the node can still answer
   * for the file and repair it, but its blocks are no longer protected.
   */
  heldLocally: boolean
  /** Names of peer nodes that acknowledged holding a copy. */
  replicas: string[]
  /**
   * Upload request that most recently registered this local lifecycle.
   *
   * Replica bookkeeping preserves the token, while a lifecycle adoption
   * replaces or clears it. A post-replication rollback can therefore distinguish
   * its own write from somebody else's lifecycle without treating every metrics
   * update as a new owner.
   */
  admissionId?: string
  /**
   * When the local upload decision became irreversible.
   *
   * The admission id may survive a failed cleanup write. This timestamp lets
   * repair and `have` distinguish that harmless residue from an upload that can
   * still roll its local record back.
   */
  admissionSettledAt?: number
  /** A remote copy prepared for one or more strict upload transactions. */
  replicaStage?: ReplicaStage
  /**
   * Opaque stamp of the write that stored this record.
   *
   * It exists so a caller can tell a planned lifecycle action apart from a
   * newer write with identical fields. Garbage collection, handover and rescue
   * all do network or blockstore work after selecting a record; without this
   * stamp they could apply that stale decision to a re-uploaded CID.
   *
   * New writes use UUIDs so a record selected before a restart cannot be
   * mistaken for a different write made afterwards. Numbers remain accepted
   * for records written by earlier versions.
   */
  revision?: string | number
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value)
}

function isReplicaStage(value: unknown): value is ReplicaStage {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const stage = value as Partial<ReplicaStage>
  const previous = stage.previous as Partial<ReplicaStageBaseline> | null | undefined
  const previousIsValid =
    previous === null ||
    (typeof previous === 'object' &&
      previous !== null &&
      previous.state === 'expired' &&
      isNullableTimestamp(previous.expiresAt) &&
      isNullableTimestamp(previous.confirmedAt) &&
      previous.pinned === false &&
      previous.heldLocally === false)

  return (
    Array.isArray(stage.transactionIds) &&
    stage.transactionIds.length > 0 &&
    new Set(stage.transactionIds).size === stage.transactionIds.length &&
    stage.transactionIds.every((id) => typeof id === 'string' && id.length > 0) &&
    previousIsValid
  )
}

/** Validate the durable shape before lifecycle policy is allowed to trust it. */
function isFileRecord(value: unknown): value is FileRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Partial<FileRecord>
  const states: FileState[] = ['temporary', 'confirmed', 'expired']
  const revisionIsValid =
    record.revision === undefined ||
    (typeof record.revision === 'string' && record.revision.length > 0) ||
    isFiniteNonNegative(record.revision)
  const admissionIsValid =
    record.admissionId === undefined ||
    (typeof record.admissionId === 'string' && record.admissionId.length > 0)
  const admissionSettlementIsValid =
    record.admissionSettledAt === undefined ||
    (record.admissionId !== undefined && isFiniteNonNegative(record.admissionSettledAt))
  const replicaStageIsValid =
    record.replicaStage === undefined ||
    (record.state === 'temporary' &&
      record.pinned === true &&
      record.heldLocally === true &&
      record.expiresAt !== null &&
      isReplicaStage(record.replicaStage))

  return (
    typeof record.cid === 'string' &&
    record.cid.length > 0 &&
    typeof record.name === 'string' &&
    record.state !== undefined &&
    states.includes(record.state) &&
    isFiniteNonNegative(record.createdAt) &&
    isNullableTimestamp(record.expiresAt) &&
    isNullableTimestamp(record.confirmedAt) &&
    isFiniteNonNegative(record.fileSize) &&
    isFiniteNonNegative(record.storedBytes) &&
    (record.protectedBytes === undefined || isFiniteNonNegative(record.protectedBytes)) &&
    typeof record.pinned === 'boolean' &&
    typeof record.heldLocally === 'boolean' &&
    Array.isArray(record.replicas) &&
    record.replicas.every((peer) => typeof peer === 'string') &&
    revisionIsValid &&
    admissionIsValid &&
    admissionSettlementIsValid &&
    replicaStageIsValid
  )
}

/** Decode a record and ensure it belongs to the datastore key that carried it. */
function decodeRecord(value: Uint8Array, expectedCid: string): FileRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(value))
    return isFileRecord(parsed) && parsed.cid === expectedCid ? parsed : undefined
  } catch {
    return undefined
  }
}

/** What {@link FileRegistry.transition} should do with a record. */
export type Transition = 'keep' | 'remove'

export interface NewFileRecord {
  cid: string
  name: string
  fileSize: number
  storedBytes: number
  /** Full DAG size when the importer or UnixFS stat can provide it. */
  protectedBytes?: number
}

export interface RegisterFileOptions {
  confirmationRequired: boolean
  temporaryTtlMs: number
  now?: number
  /** Request that owns the write until post-replication settlement. */
  admissionId?: string
}

/** A second lifecycle must not replace ownership held by an in-flight operation. */
export class FileLifecycleBusyError extends Error {
  constructor(cid: string) {
    super(`CID ${cid} has an active lifecycle transaction`)
    this.name = 'FileLifecycleBusyError'
  }
}

/**
 * Registry operations that are safe to compose while their CID locks are held.
 *
 * Calling the regular public mutators from inside {@link FileRegistry.withExclusiveCids}
 * would queue behind the lock the caller already owns. This view deliberately
 * bypasses that second acquisition while keeping the datastore operations and
 * revision stamping in one place.
 */
export interface LockedFileRegistry {
  get(cid: string): Promise<FileRecord | undefined>
  save(record: FileRecord): Promise<FileRecord>
  remove(cid: string): Promise<void>
  registerReplacing(
    file: NewFileRecord,
    options: RegisterFileOptions
  ): Promise<{ record: FileRecord; previous: FileRecord | undefined }>
}

function isNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === 'NotFoundError'
}

/**
 * True when the backing store has no directory on disk yet.
 * A node that never stored a file has an empty registry, not a broken one.
 */
function isMissingStore(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT' || isNotFound(err)
}

/**
 * Durable index of every file this node accepted, with its lifecycle state.
 *
 * The registry is the authority for "may this content be reclaimed?"; the Helia
 * pinset is the mechanism that enforces the answer.
 *
 * - `temporary`: accepted but not yet durable, reclaimable after `expiresAt`
 * - `confirmed`: durable, pinned, never reclaimed by garbage collection
 * - `expired`: released by TTL or by an explicit unpin, reclaimable now
 */
export class FileRegistry {
  constructor(
    private readonly datastore: Datastore,
    private readonly prefix: string = REGISTRY_PREFIX
  ) {}

  private key(cid: string): Key {
    return new Key(`${this.prefix}/${cid}`)
  }

  /**
   * Work already queued for a CID, so the next caller waits for it.
   *
   * Every compound operation here reads a record, decides from it, and writes
   * the result. Two of those running at once for the same CID lose one of the
   * decisions, and the datastore offers no compare-and-swap to prevent it. The
   * registry is a single instance per process, so a queue per CID is enough.
   *
   * It stopped being theoretical when the startup backfill was moved off the
   * critical path: it now runs while the API accepts uploads, and an upload
   * registering a CID between the backfill's read and its write would be
   * overwritten as confirmed — bypassing the confirmation an operator required
   * and losing the uploaded file's name.
   */
  private readonly queued = new Map<string, Promise<unknown>>()

  /**
   * CIDs whose lock is held by the call currently running.
   *
   * The class exposes two ways to change a record: the public mutators, which
   * take the lock themselves, and the {@link LockedFileRegistry} view handed to
   * {@link withExclusiveCids}, which does not. Mixing them is a deadlock: the
   * inner call queues behind a lock its own caller is holding, and neither ever
   * finishes. Nothing observable happens — no error, no timeout, just a request
   * that hangs until the client gives up.
   *
   * Tracking the held locks per asynchronous context turns that into a thrown
   * error at the call that made the mistake.
   */
  private readonly held = new AsyncLocalStorage<Set<string>>()

  /** Run `work` with nothing else touching this CID. */
  private async exclusive<T>(cid: string, work: () => Promise<T>): Promise<T> {
    const holding = this.held.getStore()

    if (holding?.has(cid)) {
      throw new Error(
        `Deadlock avoided: ${cid} is already locked by this operation. ` +
          'Use the registry passed to withExclusiveCids instead of the public mutators.'
      )
    }

    const previous = this.queued.get(cid) ?? Promise.resolve()
    // Runs whether or not the previous holder succeeded; its failure is its own.
    const result = previous.then(work, work)
    const settled = result.then(
      () => undefined,
      () => undefined
    )

    this.queued.set(cid, settled)

    try {
      return await result
    } finally {
      // The map must not keep an entry for every CID the node ever touched.
      if (this.queued.get(cid) === settled) {
        this.queued.delete(cid)
      }
    }
  }

  /**
   * Hold every requested CID lock until `work` finishes.
   *
   * Locks are acquired in lexical order, so two multi-file uploads cannot take
   * the same locks in opposite orders and deadlock. The callback receives
   * mutators that operate under those already-held locks.
   *
   * @param cids CIDs whose lifecycle and pin state must not be interleaved
   * @param work Compound operation to run while all locks are held
   */
  async withExclusiveCids<T>(
    cids: Iterable<string>,
    work: (registry: LockedFileRegistry) => Promise<T>
  ): Promise<T> {
    const ordered = [...new Set(cids)].sort()
    const locked: LockedFileRegistry = {
      get: (cid) => this.get(cid),
      save: (record) => this.save(record),
      remove: (cid) => this.removeRecord(cid),
      registerReplacing: (file, options) => this.registerExclusively(file, options)
    }

    const holding = new Set(this.held.getStore() ?? [])

    const acquire = (index: number): Promise<T> => {
      const cid = ordered[index]

      if (cid === undefined) {
        return this.held.run(holding, () => work(locked))
      }

      return this.exclusive(cid, () => {
        holding.add(cid)
        return acquire(index + 1)
      })
    }

    return acquire(0)
  }

  /**
   * Record a file, but only while the registry does not know it.
   *
   * @returns The stored record, or `undefined` when one already existed
   */
  async createIfAbsent(record: FileRecord): Promise<FileRecord | undefined> {
    return this.exclusive(record.cid, async () => {
      if (await this.get(record.cid)) {
        return undefined
      }

      return this.save(record)
    })
  }

  /**
   * Decide a record's next state from what it is now, with nothing else
   * touching the CID meanwhile.
   *
   * A decision taken from a record read earlier is stale by the time it is
   * applied: the collector plans a release and an upload may re-register the
   * same CID before the unpin runs, and a failed upload may try to undo a
   * lifecycle another request has since adopted. `work` is handed the record as
   * it is at that moment, may perform whatever must not be interleaved — an
   * unpin belongs here — and returns the record to store, `'remove'`, or
   * `'keep'` to leave it alone.
   *
   * @returns The stored record, or `undefined` when nothing was stored
   */
  async transition(
    cid: string,
    work: (current: FileRecord | undefined) => Promise<FileRecord | Transition>
  ): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const outcome = await work(await this.get(cid))

      if (outcome === 'keep') {
        return undefined
      }

      if (outcome === 'remove') {
        await this.removeRecord(cid)
        return undefined
      }

      return this.save(outcome)
    })
  }

  /**
   * Read one record.
   *
   * A record that does not decode is an error here, while {@link list} skips
   * it. The difference is deliberate: a caller asking for one CID is about to
   * act on that file and must not be told it simply does not exist, whereas a
   * sweep over every record must not be stopped by one damaged entry. Either
   * way the blocks stay protected — the collector only ever selects records it
   * could read.
   */
  async get(cid: string): Promise<FileRecord | undefined> {
    try {
      const record = decodeRecord(await this.datastore.get(this.key(cid)), cid)

      if (record === undefined) {
        throw new Error(`Invalid lifecycle registry record for ${cid}`)
      }

      return record
    } catch (err) {
      if (isNotFound(err)) {
        return undefined
      }
      throw err
    }
  }

  async save(record: FileRecord): Promise<FileRecord> {
    const stored: FileRecord = { ...record, revision: randomUUID() }

    // Checked on the way in as well as on the way out. Validating reads alone
    // lets a record be persisted that can then never be read: an absent number
    // survives `JSON.stringify` as a missing key, and the file it describes
    // disappears from the report, from repair and from every plan while its
    // pin quietly keeps the blocks. Refusing the write puts the failure where
    // the mistake is.
    if (!isFileRecord(stored)) {
      throw new Error(`Refusing to store an invalid lifecycle record for ${record.cid}`)
    }

    await this.datastore.put(this.key(stored.cid), encoder.encode(JSON.stringify(stored)))
    return stored
  }

  async remove(cid: string): Promise<void> {
    return this.exclusive(cid, () => this.removeRecord(cid))
  }

  private async removeRecord(cid: string): Promise<void> {
    try {
      await this.datastore.delete(this.key(cid))
    } catch (err) {
      if (!isNotFound(err)) {
        throw err
      }
    }
  }

  async *list(): AsyncGenerator<FileRecord> {
    // `query` may return a sync iterable (memory) or an async one (file system).
    const source = this.datastore.query({ prefix: this.prefix })
    const entries: Iterator<Pair> | AsyncIterator<Pair> =
      Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]()

    for (;;) {
      let entry

      try {
        entry = await entries.next()
      } catch (err) {
        if (isMissingStore(err)) {
          // The datastore directory is created with the first write, so a node
          // that has not stored anything yet simply has no records.
          return
        }
        throw err
      }

      if (entry.done === true) {
        return
      }

      const key = entry.value.key.toString()
      const keyPrefix = `${this.prefix}/`
      const expectedCid = key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : ''
      const record = decodeRecord(entry.value.value, expectedCid)

      if (record !== undefined) {
        yield record
      }

      // A syntactically or structurally corrupted entry must not be treated as
      // reclaimable. Ignoring it leaves its Helia pin in force until an
      // operator repairs the registry.
    }
  }

  /** Every record, materialised for callers that need more than one pass. */
  async all(): Promise<FileRecord[]> {
    const records: FileRecord[] = []
    for await (const record of this.list()) {
      records.push(record)
    }
    return records
  }

  /**
   * Register a freshly uploaded file, and report the record it replaced.
   *
   * Reachable only through {@link withExclusiveCids}, because registering
   * writes `pinned` and `heldLocally`: it describes protection it does not
   * create. Whoever writes that has to hold the CID lock and pin the content in
   * the same breath, or the record and the blockstore start disagreeing.
   *
   * A record read before the write is a guess by the time the write happens —
   * another upload of the same file can adopt the CID in between — so what was
   * replaced is captured here rather than by the caller.
   *
   * @param file Identity and size of the imported content
   * @param options `confirmationRequired` decides whether the upload becomes
   *   durable right away, which keeps the current client protocol working, or
   *   stays temporary until an authorized confirmation arrives
   */
  private async registerExclusively(
    file: NewFileRecord,
    options: RegisterFileOptions
  ): Promise<{ record: FileRecord; previous: FileRecord | undefined }> {
    const now = options.now ?? Date.now()
    const existing = await this.get(file.cid)

    // A permanent store or repair must not confirm a copy a strict upload can
    // still abort. A later local upload passes `admissionId` and takes over.
    if (existing?.replicaStage !== undefined && options.admissionId === undefined) {
      return { record: existing, previous: existing }
    }

    if (
      existing !== undefined &&
      !isAdmissionSettled(existing) &&
      existing.admissionId !== options.admissionId
    ) {
      throw new FileLifecycleBusyError(file.cid)
    }

    if (existing?.state === 'confirmed') {
      // Re-uploading already durable content must not weaken its state, and it
      // puts the blocks back on this node whether or not they were released.
      const record = await this.save({
        ...existing,
        storedBytes: Math.max(existing.storedBytes, file.storedBytes),
        protectedBytes: Math.max(
          protectedStorageBytes(existing),
          file.protectedBytes ?? Math.max(file.storedBytes, file.fileSize)
        ),
        fileSize: file.fileSize > 0 ? file.fileSize : existing.fileSize,
        pinned: true,
        heldLocally: true,
        admissionId: options.admissionId,
        admissionSettledAt: undefined,
        replicaStage: undefined
      })

      return { record, previous: existing }
    }

    const confirmed = !options.confirmationRequired

    const record = await this.save({
      cid: file.cid,
      name: file.name,
      state: confirmed ? 'confirmed' : 'temporary',
      createdAt: existing?.createdAt ?? now,
      expiresAt: confirmed ? null : now + options.temporaryTtlMs,
      confirmedAt: confirmed ? now : null,
      fileSize: file.fileSize,
      storedBytes: file.storedBytes,
      protectedBytes: file.protectedBytes ?? Math.max(file.storedBytes, file.fileSize),
      pinned: true,
      heldLocally: true,
      replicas: existing?.replicas ?? [],
      admissionId: options.admissionId,
      admissionSettledAt: undefined,
      replicaStage: undefined
    })

    return { record, previous: existing }
  }

  async setReplicas(cid: string, replicas: string[]): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      return record ? this.save({ ...record, replicas }) : undefined
    })
  }
}

/**
 * Estimate how many blockstore bytes a record's pin protects.
 *
 * Older records did not persist the full DAG size. Their write delta is exact
 * for a first import, while the logical file size prevents a cached re-upload
 * from being treated as zero bytes until it is registered again.
 */
export function protectedStorageBytes(
  record: Pick<FileRecord, 'fileSize' | 'storedBytes' | 'protectedBytes'>
): number {
  return record.protectedBytes ?? Math.max(record.storedBytes, record.fileSize)
}

/**
 * True when a temporary upload was abandoned, meaning nobody confirmed it
 * before its TTL elapsed. Confirmed files never expire.
 */
export function isExpired(record: FileRecord, now: number = Date.now()): boolean {
  if (record.state === 'expired') {
    return true
  }

  if (record.state !== 'temporary' || record.expiresAt === null) {
    return false
  }

  return record.expiresAt <= now
}

/** Files that garbage collection is allowed to unpin and reclaim. */
export function isReclaimable(record: FileRecord, now: number = Date.now()): boolean {
  return record.state !== 'confirmed' && isExpired(record, now)
}

/**
 * Durable local copy that no in-flight upload still owns.
 *
 * Repair and handover skip an admission token only until the request publishes
 * `admissionSettledAt`. The token may remain after a failed cleanup write; once
 * settled, no path can roll the local lifecycle back.
 */
export function isSettledHeldFile(record: FileRecord): boolean {
  return record.state === 'confirmed' && record.heldLocally && isAdmissionSettled(record)
}

/** Whether an upload can no longer roll this local lifecycle back. */
export function isAdmissionSettled(record: FileRecord): boolean {
  return record.admissionId === undefined || record.admissionSettledAt !== undefined
}

/**
 * True while a replica stage or an unsettled local upload still owns this CID.
 *
 * A leftover admission token after settlement is not busy: nothing can roll the
 * local decision back, and repair uses that token to retry `commit`.
 */
export function isLifecycleBusy(record: FileRecord): boolean {
  return record.replicaStage !== undefined || !isAdmissionSettled(record)
}

export function countByState(records: FileRecord[]): Record<FileState, number> {
  const counts: Record<FileState, number> = { temporary: 0, confirmed: 0, expired: 0 }
  for (const record of records) {
    counts[record.state] += 1
  }
  return counts
}
