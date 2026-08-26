import type { FileRecord, LockedFileRegistry } from './registry.js'

export interface UploadRollback {
  /** Registry view whose CID lock the caller already holds. */
  registry: LockedFileRegistry
  cid: string
  /** Request ownership token to check after releasing the lock for replication. */
  admissionId?: string
  /** What that write replaced, as reported by the write itself. */
  previous?: FileRecord
  /** Whether the pin on this CID was created by this request. */
  createdPin: boolean
  /** Removes that pin. */
  unpin: () => Promise<void>
}

/**
 * Undo what one file of a failed upload left behind.
 *
 * The caller holds the CID lock for this compensation. When network work
 * happened between registration and rollback, `admissionId` proves the record
 * still belongs to this request; a lifecycle that adopted it is left alone.
 * The real pin state is restored before the registry entry. If unpinning fails,
 * the current entry deliberately remains: a visible record for protected
 * content is recoverable, while an orphan pin is not.
 */
export async function rollbackUpload(options: UploadRollback): Promise<void> {
  if (options.admissionId !== undefined) {
    const current = await options.registry.get(options.cid)

    // A lifecycle adoption replaces or clears this token. Replica metadata
    // updates deliberately preserve it and therefore do not defeat rollback.
    if (current?.admissionId !== options.admissionId) {
      return
    }
  }

  // `pinFile` returns true only when there was no direct pin before this
  // request. Keep a newly repaired pin only when the earlier record expected
  // one; otherwise restore the real state as well as its metadata.
  if (options.createdPin && options.previous?.pinned !== true) {
    await options.unpin()
  }

  if (options.previous) {
    await options.registry.save(options.previous)
  } else {
    await options.registry.remove(options.cid)
  }
}
