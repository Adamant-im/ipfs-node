import type { FileRecord, FileRegistry } from './registry.js'

export interface UploadRollback {
  registry: FileRegistry
  cid: string
  /** The record this request stored, when it got that far. */
  written?: FileRecord
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
 * The pin and the registry record have to be undone together, under the same
 * per-CID lock, and in that order. Undoing them as two steps cannot work in
 * either order:
 *
 * - unpin first, and the check that protects a concurrent upload's content
 *   ("is anyone claiming this CID?") finds this request's own record and keeps
 *   the pin, which the next step then removes — leaving content pinned with
 *   nothing accounting for it, permanently, because session cleanup skips
 *   pinned blocks;
 * - remove the record first, and a failure to unpin afterwards leaves the same
 *   orphan.
 *
 * Nothing is undone once another request has written to the CID: it owns the
 * lifecycle and the content from that point, whether or not it created the pin
 * itself. A second upload of the same file finds it pinned already and creates
 * no pin of its own, so the pin it depends on is this one.
 */
export async function rollbackUpload(options: UploadRollback): Promise<void> {
  await options.registry.transition(options.cid, async (current) => {
    if (options.written === undefined || current?.revision !== options.written.revision) {
      return 'keep'
    }

    // A CID this node already knew keeps its earlier lifecycle: registering it
    // again may move an expired or released record to confirmed, and dropping
    // it would lose a lifecycle this request did not create. Its pin stays with
    // it.
    if (options.previous) {
      return options.previous
    }

    if (options.createdPin) {
      await options.unpin()
    }

    return 'remove'
  })
}
