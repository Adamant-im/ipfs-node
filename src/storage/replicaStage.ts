import type { UnixFS } from '@helia/unixfs'
import { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'
import { isDirectlyPinned, pinFile, unpinFile } from './pinning.js'
import type {
  FileRecord,
  FileRegistry,
  LockedFileRegistry,
  ReplicaStageBaseline
} from './registry.js'
import { protectedStorageBytes } from './registry.js'

export interface ReplicaStageTarget {
  node: IpfsNode
  unixfs: UnixFS
  registry: FileRegistry
  cid: CID
  transactionId: string
  temporaryTtlMs: number
  pinTimeoutMs?: number
  now?: number
}

export interface ReplicaStageResult {
  record: FileRecord
  /** Whether this transaction must later commit or abort the prepared copy. */
  staged: boolean
}

/** Build the optional deadline shared by one pin and its offline stat. */
function stageSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
}

/** Restore the pin and record after a failed stage write. */
async function restoreStageWrite(
  registry: LockedFileRegistry,
  node: IpfsNode,
  cid: CID,
  previous: FileRecord | undefined,
  createdPin: boolean,
  originalError: unknown
): Promise<never> {
  const failures: unknown[] = [originalError]

  try {
    if (createdPin) {
      await unpinFile(node, cid)
    }
  } catch (err) {
    failures.push(err)
  }

  try {
    if (previous === undefined) {
      await registry.remove(cid.toString())
    } else {
      await registry.save(previous)
    }
  } catch (err) {
    failures.push(err)
  }

  if (failures.length > 1) {
    throw new AggregateError(failures, 'Replica staging failed and its baseline was not restored')
  }

  throw originalError
}

/** Persist a pre-existing durable pin as a stable, non-transactional replica. */
async function registerStableReplica(
  registry: LockedFileRegistry,
  options: ReplicaStageTarget,
  previous: FileRecord | undefined,
  createdPin: boolean,
  now: number,
  signal: AbortSignal | undefined
): Promise<ReplicaStageResult> {
  try {
    const stats = await options.unixfs.stat(options.cid, {
      extended: true,
      offline: true,
      signal
    })
    const dagBytes = Number(stats.deduplicatedDagSize)
    const record = await registry.save({
      cid: options.cid.toString(),
      name: previous?.name ?? options.cid.toString(),
      state: 'confirmed',
      createdAt: previous?.createdAt ?? now,
      expiresAt: null,
      confirmedAt: previous?.confirmedAt ?? now,
      fileSize: Number(stats.size),
      storedBytes: Math.max(previous?.storedBytes ?? 0, dagBytes),
      protectedBytes: Math.max(
        previous === undefined ? 0 : protectedStorageBytes(previous),
        dagBytes
      ),
      pinned: true,
      heldLocally: true,
      replicas: previous?.replicas ?? [],
      admissionId: previous?.admissionId,
      replicaStage: undefined
    })

    return { record, staged: false }
  } catch (err) {
    return restoreStageWrite(registry, options.node, options.cid, previous, createdPin, err)
  }
}

/**
 * Prepare a durable copy for a strict upload without making rejection permanent.
 *
 * A new copy is pinned as `temporary` and carries every upload transaction that
 * currently depends on it. One successful transaction commits the shared copy;
 * failed transactions remove only their own claim, and the last failure restores
 * the expired baseline or removes a record this staging created.
 */
export async function stageReplica(options: ReplicaStageTarget): Promise<ReplicaStageResult> {
  const key = options.cid.toString()
  const now = options.now ?? Date.now()
  const signal = stageSignal(options.pinTimeoutMs)

  return options.registry.withExclusiveCids([key], async (registry) => {
    const previous = await registry.get(key)

    if (previous?.replicaStage !== undefined) {
      await pinFile(options.node, options.cid, signal)

      try {
        const transactionIds = previous.replicaStage.transactionIds.includes(options.transactionId)
          ? previous.replicaStage.transactionIds
          : [...previous.replicaStage.transactionIds, options.transactionId]
        const record = await registry.save({
          ...previous,
          state: 'temporary',
          expiresAt: Math.max(previous.expiresAt ?? 0, now + options.temporaryTtlMs),
          pinned: true,
          heldLocally: true,
          replicaStage: { ...previous.replicaStage, transactionIds }
        })

        return { record, staged: true }
      } catch (err) {
        // Other transactions still own this pin. A failed join must not unpin
        // it, even when this call recreated a pin a collector had just removed.
        return restoreStageWrite(registry, options.node, options.cid, previous, false, err)
      }
    }

    // A local unconfirmed upload owns this lifecycle. An unrelated replication
    // request must not silently confirm it, nor can it safely undo it later.
    if (previous?.state === 'temporary') {
      throw new Error(`CID ${key} already has an unrelated temporary lifecycle`)
    }

    const wasDirectlyPinned = await isDirectlyPinned(options.node, options.cid)

    // Existing pins and confirmed records predate this transaction. Repairing
    // their protection is safe to keep even if the new upload is rejected.
    if (wasDirectlyPinned || previous?.state === 'confirmed') {
      const createdPin = await pinFile(options.node, options.cid, signal)
      return registerStableReplica(registry, options, previous, createdPin, now, signal)
    }

    const createdPin = await pinFile(options.node, options.cid, signal)

    try {
      const stats = await options.unixfs.stat(options.cid, {
        extended: true,
        offline: true,
        signal
      })
      const dagBytes = Number(stats.deduplicatedDagSize)
      const baseline: ReplicaStageBaseline | null = previous
        ? {
            state: 'expired',
            expiresAt: previous.expiresAt,
            confirmedAt: previous.confirmedAt,
            pinned: false,
            heldLocally: false
          }
        : null
      const record = await registry.save({
        cid: key,
        name: previous?.name ?? key,
        state: 'temporary',
        createdAt: previous?.createdAt ?? now,
        expiresAt: now + options.temporaryTtlMs,
        confirmedAt: null,
        fileSize: Number(stats.size),
        storedBytes: Math.max(previous?.storedBytes ?? 0, dagBytes),
        protectedBytes: Math.max(
          previous === undefined ? 0 : protectedStorageBytes(previous),
          dagBytes
        ),
        pinned: true,
        heldLocally: true,
        replicas: previous?.replicas ?? [],
        admissionId: previous?.admissionId,
        replicaStage: { transactionIds: [options.transactionId], previous: baseline }
      })

      return { record, staged: true }
    } catch (err) {
      return restoreStageWrite(registry, options.node, options.cid, previous, createdPin, err)
    }
  })
}

export interface SettleReplicaOptions {
  node: IpfsNode
  registry: FileRegistry
  cid: CID
  transactionId: string
  now?: number
}

/** Make a prepared copy durable. One commit settles every transaction sharing it. */
export async function commitReplica(
  options: SettleReplicaOptions
): Promise<FileRecord | undefined> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)

    if (!current?.replicaStage?.transactionIds.includes(options.transactionId)) {
      return current
    }

    return registry.save({
      ...current,
      state: 'confirmed',
      expiresAt: null,
      confirmedAt: current.confirmedAt ?? options.now ?? Date.now(),
      pinned: true,
      heldLocally: true,
      admissionId: undefined,
      replicaStage: undefined
    })
  })
}

/**
 * Restore or remove one prepared replica while its CID lock is held.
 *
 * @param keepCreatedRecord Keep an `expired` entry for GC accounting. Explicit
 *   aborts remove entries they created; TTL expiry keeps one until collection.
 */
export async function restoreReplicaStage(
  registry: LockedFileRegistry,
  node: IpfsNode,
  current: FileRecord,
  keepCreatedRecord: boolean
): Promise<FileRecord | undefined> {
  const removedPin = await unpinFile(node, currentCid(current))

  try {
    const previous = current.replicaStage?.previous

    if (previous === null && !keepCreatedRecord) {
      await registry.remove(current.cid)
      return undefined
    }

    return registry.save({
      ...current,
      ...(previous ?? {
        state: 'expired' as const,
        expiresAt: current.expiresAt,
        confirmedAt: null,
        pinned: false as const,
        heldLocally: false as const
      }),
      replicaStage: undefined
    })
  } catch (err) {
    const failures: unknown[] = [err]

    try {
      if (removedPin) {
        await pinFile(node, currentCid(current))
      }
      await registry.save(current)
    } catch (restoreError) {
      failures.push(restoreError)
    }

    throw new AggregateError(
      failures,
      'Replica rollback failed and its staged state was restored',
      {
        cause: err
      }
    )
  }
}

/** Parse a record CID only at the pin boundary. */
function currentCid(record: FileRecord): CID {
  return CID.parse(record.cid)
}

/** Remove this transaction's claim, restoring the baseline after the last claim. */
export async function abortReplica(options: SettleReplicaOptions): Promise<FileRecord | undefined> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)
    const stage = current?.replicaStage

    if (
      current === undefined ||
      stage === undefined ||
      !stage.transactionIds.includes(options.transactionId)
    ) {
      return current
    }

    const transactionIds = stage.transactionIds.filter((id) => id !== options.transactionId)

    if (transactionIds.length > 0) {
      return registry.save({ ...current, replicaStage: { ...stage, transactionIds } })
    }

    return restoreReplicaStage(registry, options.node, current, false)
  })
}
