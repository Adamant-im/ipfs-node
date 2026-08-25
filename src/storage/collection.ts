import type { IpfsNode } from '../ipfs-node.js'
import { runGarbageCollection, type GcReport, type Watermarks } from './gc.js'
import type { StorageOperationLock } from './operationLock.js'
import type { FileRegistry } from './registry.js'

/** A collection pass, plus the copies it handed over to other nodes first. */
export interface CollectionReport extends GcReport {
  /** Files whose local copy was released because peers hold enough copies. */
  demoted: string[]
}

export interface CollectStorageOptions {
  lock: StorageOperationLock
  node: IpfsNode
  registry: FileRegistry
  watermarks: Watermarks
  /** Free bytes uploads must never consume. */
  reserveBytes: number
  /** Bounds the DAG walk when a missing pin has to be restored. */
  pinTimeoutMs?: number
  /** Hands copies over to their designated holders, and reports which. */
  demote: (options: { dryRun?: boolean }) => Promise<{ demoted: string[] }>
  /** Measures the blockstore and the volume it sits on. */
  measure: () => Promise<{ blockstoreBytes: number; availableBytes: number }>
  dryRun?: boolean
  force?: boolean
  log?: (message: string) => void
}

/**
 * Run one collection pass: hand over what belongs elsewhere, then reclaim.
 *
 * Everything it needs is passed in rather than imported, which is what lets a
 * test drive it against a throwaway node and a real lock. The wiring is the
 * part worth testing here: Helia GC must not start while an upload is between
 * its first block write and its pin, and that is a property of *taking* the
 * exclusive lease at deletion, not of the lock in isolation.
 *
 * The handover runs **before** the lease is taken. It asks every designated
 * holder whether it has the file, one candidate after another, and each of
 * those questions may wait for a network timeout — a batch of them inside the
 * exclusive lease would hold every upload on the node for as long as the
 * slowest peer takes to not answer. Nothing it does needs the lease: it unpins
 * copies that other nodes already hold, which is work this pass is about to
 * reclaim anyway.
 */
export async function collectStorage(options: CollectStorageOptions): Promise<CollectionReport> {
  const { demoted } = await options.demote({ dryRun: options.dryRun })
  const metrics = await options.measure()

  const report = await runGarbageCollection({
    node: options.node,
    registry: options.registry,
    watermarks: options.watermarks,
    blockstoreBytes: metrics.blockstoreBytes,
    availableBytes: metrics.availableBytes,
    reserveBytes: options.reserveBytes,
    dryRun: options.dryRun,
    force: options.force,
    pinTimeoutMs: options.pinTimeoutMs,
    withCollectionLease: (work) => options.lock.withExclusive(work),
    log: options.log
  })

  return { ...report, demoted }
}
