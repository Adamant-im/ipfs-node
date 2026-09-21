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
import { isAdmissionSettled, protectedStorageBytes } from './registry.js'

/**
 * Abort markers close the race where an abort reaches the peer while its stage
 * request is still pulling blocks and has not written transaction ownership.
 * They live in this process. A coordinator that already aborted will not reuse
 * the same transaction id, so a source restart is a new request. If this node
 * restarts while a late `stage` is still in flight, that copy can appear until
 * settlement TTL — the same bound already used for abandoned stages.
 */
const abortedTransactions = new Map<string, number>()
const DEFAULT_ABORT_TOMBSTONE_TTL_MS = 5 * 60 * 1000
const MAX_ABORT_TOMBSTONES = 10_000

function transactionPrefix(cid: string, transactionId: string): string {
  return `${cid}\0${transactionId}\0`
}

function transactionKey(
  cid: string,
  transactionId: string,
  originPeerId: string | undefined
): string {
  return `${transactionPrefix(cid, transactionId)}${originPeerId ?? ''}`
}

function pruneAbortTombstones(now: number): void {
  for (const [key, expiresAt] of abortedTransactions) {
    if (expiresAt <= now) {
      abortedTransactions.delete(key)
    }
  }

  while (abortedTransactions.size > MAX_ABORT_TOMBSTONES) {
    const oldest = abortedTransactions.keys().next().value as string | undefined
    if (oldest === undefined) {
      break
    }
    abortedTransactions.delete(oldest)
  }
}

function rememberAbort(
  cid: string,
  transactionId: string,
  expiresAt: number,
  now: number,
  originPeerId?: string
): void {
  pruneAbortTombstones(now)
  abortedTransactions.set(transactionKey(cid, transactionId, originPeerId), expiresAt)
  pruneAbortTombstones(now)
}

function wasAborted(
  cid: string,
  transactionId: string,
  originPeerId: string | undefined,
  now: number
): boolean {
  pruneAbortTombstones(now)
  const prefix = transactionPrefix(cid, transactionId)

  // Protocol calls always identify their peer. Keeping unknown legacy callers
  // conservative preserves the old abort-before-stage behaviour.
  if (originPeerId === undefined) {
    return [...abortedTransactions.keys()].some((key) => key.startsWith(prefix))
  }

  return (
    abortedTransactions.has(transactionKey(cid, transactionId, undefined)) ||
    abortedTransactions.has(transactionKey(cid, transactionId, originPeerId))
  )
}

function withOrigin(
  previous: Record<string, string> | undefined,
  transactionId: string,
  originPeerId: string | undefined
): Record<string, string> | undefined {
  if (originPeerId === undefined) {
    return previous
  }

  return { ...previous, [transactionId]: originPeerId }
}

function assertStageOwner(
  transactionId: string,
  origin: string | undefined,
  peerId: string | undefined
): void {
  if (origin === undefined || peerId === undefined || origin === peerId) {
    return
  }

  throw new Error(`Replica transaction ${transactionId} was staged by another peer`)
}

export interface ReplicaStageTarget {
  node: IpfsNode
  unixfs: UnixFS
  registry: FileRegistry
  cid: CID
  transactionId: string
  temporaryTtlMs: number
  pinTimeoutMs?: number
  now?: number
  /** libp2p peer that asked to stage; commit and abort must come from it. */
  originPeerId?: string
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
      admissionSettledAt: previous?.admissionSettledAt,
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
    if (wasAborted(key, options.transactionId, options.originPeerId, now)) {
      throw new Error(`Replica transaction ${options.transactionId} for ${key} was already aborted`)
    }

    const previous = await registry.get(key)

    if (previous?.replicaStage !== undefined) {
      const alreadyStaged = previous.replicaStage.transactionIds.includes(options.transactionId)

      if (alreadyStaged) {
        assertStageOwner(
          options.transactionId,
          previous.replicaStage.origins?.[options.transactionId],
          options.originPeerId
        )
      }

      await pinFile(options.node, options.cid)

      try {
        const transactionIds = alreadyStaged
          ? previous.replicaStage.transactionIds
          : [...previous.replicaStage.transactionIds, options.transactionId]
        const record = await registry.save({
          ...previous,
          state: 'temporary',
          expiresAt: Math.max(previous.expiresAt ?? 0, now + options.temporaryTtlMs),
          pinned: true,
          heldLocally: true,
          replicaStage: {
            ...previous.replicaStage,
            transactionIds,
            origins: alreadyStaged
              ? previous.replicaStage.origins
              : withOrigin(
                  previous.replicaStage.origins,
                  options.transactionId,
                  options.originPeerId
                )
          }
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

    if (previous !== undefined && !isAdmissionSettled(previous)) {
      throw new Error(`CID ${key} belongs to an unsettled local upload`)
    }

    const wasDirectlyPinned = await isDirectlyPinned(options.node, options.cid)

    // Existing pins and confirmed records predate this transaction. Repairing
    // their protection is safe to keep even if the new upload is rejected.
    if (wasDirectlyPinned || previous?.state === 'confirmed') {
      const createdPin = await pinFile(options.node, options.cid)
      return registerStableReplica(registry, options, previous, createdPin, now, signal)
    }

    const createdPin = await pinFile(options.node, options.cid)

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
        admissionSettledAt: previous?.admissionSettledAt,
        replicaStage: {
          transactionIds: [options.transactionId],
          origins: withOrigin(undefined, options.transactionId, options.originPeerId),
          previous: baseline
        }
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
  /** How long a missing-stage abort rejects a stage request still in flight. */
  tombstoneTtlMs?: number
  /** libp2p peer asking to settle; must match the staging peer when known. */
  peerId?: string
}

/** Make a prepared copy durable. One commit settles every transaction sharing it. */
export async function commitReplica(
  options: SettleReplicaOptions
): Promise<FileRecord | undefined> {
  const key = options.cid.toString()

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)

    if (!current?.replicaStage?.transactionIds.includes(options.transactionId)) {
      if (
        current?.state === 'confirmed' &&
        current.pinned &&
        current.heldLocally &&
        isAdmissionSettled(current)
      ) {
        // Idempotent retry after this transaction (or a concurrent transaction
        // sharing its stage) already committed the copy.
        return current
      }

      throw new Error(`Replica transaction ${options.transactionId} for ${key} is not staged`)
    }

    assertStageOwner(
      options.transactionId,
      current.replicaStage.origins?.[options.transactionId],
      options.peerId
    )

    return registry.save({
      ...current,
      state: 'confirmed',
      expiresAt: null,
      confirmedAt: current.confirmedAt ?? options.now ?? Date.now(),
      pinned: true,
      heldLocally: true,
      admissionId: undefined,
      admissionSettledAt: undefined,
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
  const now = options.now ?? Date.now()
  const tombstoneUntil = now + (options.tombstoneTtlMs ?? DEFAULT_ABORT_TOMBSTONE_TTL_MS)

  return options.registry.withExclusiveCids([key], async (registry) => {
    const current = await registry.get(key)
    const stage = current?.replicaStage

    if (
      current === undefined ||
      stage === undefined ||
      !stage.transactionIds.includes(options.transactionId)
    ) {
      rememberAbort(key, options.transactionId, tombstoneUntil, now, options.peerId)
      return current
    }

    assertStageOwner(options.transactionId, stage.origins?.[options.transactionId], options.peerId)
    rememberAbort(key, options.transactionId, tombstoneUntil, now, options.peerId)

    const transactionIds = stage.transactionIds.filter((id) => id !== options.transactionId)
    const origins = { ...stage.origins }
    delete origins[options.transactionId]
    const nextOrigins = Object.keys(origins).length > 0 ? origins : undefined

    if (transactionIds.length > 0) {
      return registry.save({
        ...current,
        replicaStage: { ...stage, transactionIds, origins: nextOrigins }
      })
    }

    return restoreReplicaStage(registry, options.node, current, false)
  })
}
