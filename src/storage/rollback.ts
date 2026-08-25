import type { FileRecord, LockedFileRegistry } from './registry.js'

export interface UploadRollback {
  /** Registry view whose CID lock the caller already holds. */
  registry: LockedFileRegistry
  cid: string
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
 * The caller holds the CID lock from registration through request commit or
 * rollback. No other request can adopt the pin between these steps, so this
 * first restores the real pin state and only then restores or removes the
 * registry entry. If unpinning fails, the current entry deliberately remains:
 * a visible record for protected content is recoverable, while an orphan pin
 * is not.
 */
export async function rollbackUpload(options: UploadRollback): Promise<void> {
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
