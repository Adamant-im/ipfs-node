import type { UnixFS } from '@helia/unixfs'
import type { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'
import { pinFile, unpinFile } from './pinning.js'
import type { FileRecord, FileRegistry, LockedFileRegistry } from './registry.js'

/**
 * The lifecycle transitions that change a pin and a record together.
 *
 * They take what they work on rather than reaching for the node and the
 * registry the process happens to have started with — the same shape garbage
 * collection already uses. That is what makes them exercisable against a
 * throwaway node in a test, which matters more here than elsewhere: each of
 * them writes `pinned` and `heldLocally`, so a mistake produces a record that
 * claims a protection the blockstore does not have.
 */
export interface LifecycleTarget {
  node: IpfsNode
  registry: FileRegistry
}

export interface RegisterPinnedOptions extends LifecycleTarget {
  unixfs: UnixFS
  cid: CID
  /** Display name recorded for the file; defaults to its CID. */
  name?: string
  /** Lifetime an unconfirmed upload would get; unused here, since this path is durable. */
  temporaryTtlMs: number
  /** Bounds the DAG walk when the content still has to be fetched. */
  pinTimeoutMs?: number
}

/**
 * Pin content and record it as durable, with the CID locked throughout.
 *
 * The DAG is pulled over libp2p if it is missing locally, bounded by
 * `pinTimeoutMs` so an unreachable CID cannot hang the caller.
 */
export async function registerPinnedFile(options: RegisterPinnedOptions): Promise<FileRecord> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) =>
    registerPinnedUnderLock(registry, options, await registry.get(key))
  )
}

/**
 * The body of {@link registerPinnedFile}, for a caller that already holds the
 * CID lock and has read the record.
 */
async function registerPinnedUnderLock(
  registry: LockedFileRegistry,
  options: RegisterPinnedOptions,
  previous: FileRecord | undefined
): Promise<FileRecord> {
  const signal =
    options.pinTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.pinTimeoutMs)
  const createdPin = await pinFile(options.node, options.cid, signal)

  try {
    // Everything is local after pinning, so the deduplicated DAG size is what
    // this node actually holds on disk for the file.
    const stats = await options.unixfs.stat(options.cid, {
      extended: true,
      offline: true,
      signal
    })

    return (
      await registry.registerReplacing(
        {
          cid: options.cid.toString(),
          name: options.name ?? options.cid.toString(),
          fileSize: Number(stats.size),
          storedBytes: Number(stats.deduplicatedDagSize)
        },
        { confirmationRequired: false, temporaryTtlMs: options.temporaryTtlMs }
      )
    ).record
  } catch (err) {
    // A failed stat or datastore write must not leave a pin no lifecycle owns.
    if (createdPin && previous?.pinned !== true) {
      await unpinFile(options.node, options.cid)
    }

    throw err
  }
}

export interface ConfirmOptions extends RegisterPinnedOptions {
  /**
   * What to do with a CID the node never accepted through an upload.
   *
   * The confirmation endpoint reports it as unknown; an explicit pin request
   * stores and registers it.
   */
  registerUnknown?: boolean
  now?: number
}

/**
 * Make a known file durable, or adopt an unknown one.
 *
 * The final state check, the pin and the registry write happen under one CID
 * lock. Split apart, a concurrent release could remove the pin between the two,
 * and this would then publish a `confirmed`, `pinned` record for content that is
 * no longer protected.
 *
 * @returns The stored record, or `undefined` for an unknown CID that this call
 *   was not asked to adopt
 */
export async function confirmStoredFile(options: ConfirmOptions): Promise<FileRecord | undefined> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)

    if (!current) {
      return options.registerUnknown === true
        ? registerPinnedUnderLock(registry, options, current)
        : undefined
    }

    const createdPin = await pinFile(options.node, options.cid)

    try {
      return await registry.save({
        ...current,
        state: 'confirmed',
        expiresAt: null,
        confirmedAt: current.confirmedAt ?? options.now ?? Date.now(),
        pinned: true,
        heldLocally: true
      })
    } catch (err) {
      if (createdPin && current.pinned !== true) {
        await unpinFile(options.node, options.cid)
      }

      throw err
    }
  })
}

export interface ReleaseOptions extends LifecycleTarget {
  cid: CID
}

/**
 * Release a file so garbage collection may reclaim it.
 *
 * Blocks stay on disk until the collector runs, which keeps the action
 * reversible until then.
 *
 * @returns The released record, or `undefined` when the registry does not know
 *   the CID — in which case nothing was unpinned either
 */
export async function releaseStoredFile(options: ReleaseOptions): Promise<FileRecord | undefined> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)

    // Nothing is unpinned for a CID the registry does not know. Startup records
    // every pin this node holds, so an unknown CID is either not pinned at all
    // or has not been reconciled yet — and reconciliation is exactly the window
    // in which removing a pin would drop protection from content that predates
    // the registry.
    if (!current) {
      return undefined
    }

    const removedPin = await unpinFile(options.node, options.cid)

    try {
      return await registry.save({
        ...current,
        state: 'expired',
        pinned: false,
        heldLocally: false
      })
    } catch (err) {
      // The lifecycle still promises protection when the datastore write did
      // not land, so restore the pin before exposing the failure.
      if (removedPin && current.pinned) {
        await pinFile(options.node, options.cid)
      }

      throw err
    }
  })
}
