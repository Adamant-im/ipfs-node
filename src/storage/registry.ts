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
  /** Names of peer nodes that acknowledged holding a copy. */
  replicas: string[]
}

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
    await this.datastore.put(this.key(record.cid), encoder.encode(JSON.stringify(record)))
    return record
  }

  async remove(cid: string): Promise<void> {
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
    const now = options.now ?? Date.now()
    const existing = await this.get(file.cid)

    if (existing?.state === 'confirmed') {
      // Re-uploading already durable content must not weaken its state.
      return this.save({
        ...existing,
        storedBytes: Math.max(existing.storedBytes, file.storedBytes),
        fileSize: file.fileSize > 0 ? file.fileSize : existing.fileSize
      })
    }

    const confirmed = !options.confirmationRequired

    return this.save({
      cid: file.cid,
      name: file.name,
      state: confirmed ? 'confirmed' : 'temporary',
      createdAt: existing?.createdAt ?? now,
      expiresAt: confirmed ? null : now + options.temporaryTtlMs,
      confirmedAt: confirmed ? now : null,
      fileSize: file.fileSize,
      storedBytes: file.storedBytes,
      pinned: true,
      replicas: existing?.replicas ?? []
    })
  }

  /** Move a temporary file to the durable state. Confirming twice is a no-op. */
  async confirm(cid: string, now: number = Date.now()): Promise<FileRecord | undefined> {
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
      pinned: true
    })
  }

  /**
   * Release a file so that garbage collection may reclaim it.
   * The blocks stay on disk until the collector runs.
   */
  async release(cid: string): Promise<FileRecord | undefined> {
    const record = await this.get(cid)
    if (!record) {
      return undefined
    }

    return this.save({ ...record, state: 'expired', pinned: false })
  }

  async setPinned(cid: string, pinned: boolean): Promise<FileRecord | undefined> {
    const record = await this.get(cid)
    return record ? this.save({ ...record, pinned }) : undefined
  }

  async setReplicas(cid: string, replicas: string[]): Promise<FileRecord | undefined> {
    const record = await this.get(cid)
    return record ? this.save({ ...record, replicas }) : undefined
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
