import { Key } from 'interface-datastore'
import type { Datastore, Pair } from 'interface-datastore'

/**
 * Datastore namespace of the lifecycle registry.
 * It is kept separate from the Helia records stored in the same datastore.
 */
export const REGISTRY_PREFIX = '/adm/files'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Stamps every stored record, so two writes are never mistaken for one.
 *
 * A counter carried on the record itself would reset whenever a writer builds a
 * fresh record rather than editing the stored one, which is exactly what
 * registering an already-known CID does.
 */
let writes = 0

/** Lifecycle state of a file known to this node. */
export type FileState = 'temporary' | 'confirmed' | 'expired'

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
   * Opaque stamp of the write that stored this record.
   *
   * It exists so a caller can tell its own write apart from an identical one
   * made by somebody else. Two concurrent uploads of the same file produce
   * records that match field for field, so without this the compensation of a
   * failed upload cannot see that another request has since adopted the CID —
   * and would undo work that succeeded.
   *
   * It is unique within a process run and means nothing across restarts, which
   * is all it is compared over: a caller only ever checks a record against a
   * stamp it was handed by its own write.
   */
  revision?: number
}

/** What {@link FileRegistry.transition} should do with a record. */
export type Transition = 'keep' | 'remove'

export interface NewFileRecord {
  cid: string
  name: string
  fileSize: number
  storedBytes: number
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

  /** Run `work` with nothing else touching this CID. */
  private async exclusive<T>(cid: string, work: () => Promise<T>): Promise<T> {
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

  async get(cid: string): Promise<FileRecord | undefined> {
    try {
      return JSON.parse(decoder.decode(await this.datastore.get(this.key(cid)))) as FileRecord
    } catch (err) {
      if (isNotFound(err)) {
        return undefined
      }
      throw err
    }
  }

  async save(record: FileRecord): Promise<FileRecord> {
    writes += 1
    const stored: FileRecord = { ...record, revision: writes }
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

      try {
        yield JSON.parse(decoder.decode(entry.value.value)) as FileRecord
      } catch {
        // A corrupted entry must not stop the whole sweep; garbage collection
        // ignores it and the blocks stay protected until it is repaired.
        continue
      }
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
   * Register a freshly uploaded file.
   *
   * @param file Identity and size of the imported content
   * @param options `confirmationRequired` decides whether the upload becomes
   *   durable right away, which keeps the current client protocol working, or
   *   stays temporary until an authorized confirmation arrives
   */
  async register(
    file: NewFileRecord,
    options: { confirmationRequired: boolean; temporaryTtlMs: number; now?: number }
  ): Promise<FileRecord> {
    return (await this.registerReplacing(file, options)).record
  }

  /**
   * Register an upload and report the record it replaced.
   *
   * A record read before the write is already a guess by the time the write
   * happens: another upload of the same file can adopt the CID in between. A
   * rollback restoring what the caller saw earlier would erase the lifecycle
   * that upload owns, so the replaced record is captured inside the same
   * serialised section as the write that replaced it.
   */
  async registerReplacing(
    file: NewFileRecord,
    options: { confirmationRequired: boolean; temporaryTtlMs: number; now?: number }
  ): Promise<{ record: FileRecord; previous: FileRecord | undefined }> {
    return this.exclusive(file.cid, () => this.registerExclusively(file, options))
  }

  private async registerExclusively(
    file: NewFileRecord,
    options: { confirmationRequired: boolean; temporaryTtlMs: number; now?: number }
  ): Promise<{ record: FileRecord; previous: FileRecord | undefined }> {
    const now = options.now ?? Date.now()
    const existing = await this.get(file.cid)

    if (existing?.state === 'confirmed') {
      // Re-uploading already durable content must not weaken its state, and it
      // puts the blocks back on this node whether or not they were released.
      const record = await this.save({
        ...existing,
        storedBytes: Math.max(existing.storedBytes, file.storedBytes),
        fileSize: file.fileSize > 0 ? file.fileSize : existing.fileSize,
        pinned: true,
        heldLocally: true
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
      pinned: true,
      heldLocally: true,
      replicas: existing?.replicas ?? []
    })

    return { record, previous: existing }
  }

  /** Move a temporary file to the durable state. Confirming twice is a no-op. */
  async confirm(cid: string, now: number = Date.now()): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      if (!record) {
        return undefined
      }

      if (record.state === 'confirmed') {
        return record
      }

      return this.save({
        ...record,
        state: 'confirmed',
        expiresAt: null,
        confirmedAt: now,
        pinned: true,
        heldLocally: true
      })
    })
  }

  /**
   * Release a file so that garbage collection may reclaim it.
   * The blocks stay on disk until the collector runs.
   */
  async release(cid: string): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      if (!record) {
        return undefined
      }

      return this.save({ ...record, state: 'expired', pinned: false, heldLocally: false })
    })
  }

  /**
   * Record that the file now lives on other nodes only.
   *
   * The file stays `confirmed` because it is still durable in the network; this
   * node simply stopped being one of its holders.
   */
  async releaseLocalCopy(cid: string): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      return record ? this.save({ ...record, pinned: false, heldLocally: false }) : undefined
    })
  }

  async setPinned(cid: string, pinned: boolean): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      return record ? this.save({ ...record, pinned }) : undefined
    })
  }

  async setReplicas(cid: string, replicas: string[]): Promise<FileRecord | undefined> {
    return this.exclusive(cid, async () => {
      const record = await this.get(cid)
      return record ? this.save({ ...record, replicas }) : undefined
    })
  }
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

export function countByState(records: FileRecord[]): Record<FileState, number> {
  const counts: Record<FileState, number> = { temporary: 0, confirmed: 0, expired: 0 }
  for (const record of records) {
    counts[record.state] += 1
  }
  return counts
}
