import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { Key } from 'interface-datastore'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { Readable } from 'node:stream'
import type { Request } from 'express'
import { CID } from 'multiformats/cid'
import { UnixfsMulterStorage } from '../../src/utils/unixfs-multer.storage.js'
import type { UnixFsMulterFile } from '../../src/utils/types.js'
import { createIpfsNode, type IpfsNode } from '../../src/ipfs-node.js'
import { createUploadAdmission, getUploadSession } from '../../src/middleware/uploadAdmission.js'
import { backfillRegistryFromPins, snapshotPins } from '../../src/storage/backfill.js'
import { collectStorage } from '../../src/storage/collection.js'
import { runGarbageCollection } from '../../src/storage/gc.js'
import {
  confirmStoredFile,
  registerPinnedFile,
  releaseStoredFile
} from '../../src/storage/lifecycle.js'
import {
  INTAKE_OVERSHOOT_BYTES,
  INTAKE_READ_CONCURRENCY,
  meteredBlocks
} from '../../src/storage/meter.js'
import { ConcurrencyLimiter } from '../../src/storage/limits.js'
import { StorageOperationLock } from '../../src/storage/operationLock.js'
import { isDirectlyPinned, isProtected, pinFile, unpinFile } from '../../src/storage/pinning.js'
import { FileRegistry, type FileRecord } from '../../src/storage/registry.js'
import { abortReplica, commitReplica, stageReplica } from '../../src/storage/replicaStage.js'
import { UploadSession } from '../../src/storage/uploadSession.js'
import { deterministicBytes } from '../fixtures.js'

/**
 * Deletion fencing for a test that is the only writer.
 *
 * The real collector passes the storage lease here. Stating it at every call
 * keeps the parameter impossible to forget where it does matter.
 */
const runWithoutOtherWriters = <T>(work: () => Promise<T>): Promise<T> => work()

/** Only loopback, and port 0 so the OS picks a free port. */
const LISTEN = ['/ip4/127.0.0.1/tcp/0']
const WATERMARKS = { highWatermarkBytes: 1_000_000_000, lowWatermarkBytes: 500_000_000 }
/**
 * Space is short, but releasing the expired file alone brings the estimate back
 * under the low watermark, so nothing else has to be evicted.
 */
const TIGHT = { highWatermarkBytes: 3500, lowWatermarkBytes: 3100 }

let storeDir: string
let blockstore: FsBlockstore
let datastore: FsDatastore
let node: IpfsNode
let ifs: UnixFS
let prefixCounter = 0

function createRegistry(): FileRegistry {
  prefixCounter += 1
  return new FileRegistry(datastore, `/adm/lifecycle-${prefixCounter}`)
}

function createSession(
  maxRequestSizeBytes = 64 * 1024 * 1024,
  onSettle?: () => void
): UploadSession {
  return new UploadSession({
    blockstore: node.blockstore,
    isPinned: (cid) => node.pins.isPinned(cid),
    deleteBlock: (cid) => blockstore.delete(cid),
    maxRequestSizeBytes,
    parseCid: (value) => CID.parse(value),
    onCleanupError: (err) => assert.fail(`unexpected cleanup error: ${err.message}`),
    onSettle
  })
}

class AdmissionResponse extends EventEmitter {
  statusCode = 200
  body: unknown

  set(): this {
    return this
  }

  status(value: number): this {
    this.statusCode = value
    return this
  }

  send(value: unknown): this {
    this.body = value
    return this
  }
}

/** Admit one request through the same middleware implementation production uses. */
async function admitThrough(lock: StorageOperationLock): Promise<{
  response: AdmissionResponse
  session: UploadSession
}> {
  const admission = createUploadAdmission({
    storage: { maxRequestSizeBytes: 64 * 1024 * 1024, diskReserveBytes: 1 },
    limiter: new ConcurrencyLimiter(2),
    operationLock: lock,
    availableStorageSize: async () => 1024n ** 4n,
    blockstore: node.blockstore,
    isPinned: (cid) => node.pins.isPinned(cid),
    deleteBlock: (cid) => blockstore.delete(cid),
    parseCid: (value) => CID.parse(value),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (message) => assert.fail(String(message))
    }
  })
  const request = { headers: { 'content-length': '1048576' } }
  const response = new AdmissionResponse()

  await new Promise<void>((resolve, reject) => {
    admission(request as never, response as never, (error?: unknown) =>
      error === undefined ? resolve() : reject(error)
    )
  })

  assert.equal(response.statusCode, 200)
  return { response, session: getUploadSession(request as never) }
}

/** Register a file the way an upload does: under the CID lock. */
function registerFile(
  registry: FileRegistry,
  file: { cid: string; name: string; fileSize: number; storedBytes: number },
  options: { confirmationRequired: boolean; temporaryTtlMs: number; now?: number }
): Promise<FileRecord> {
  return registry.withExclusiveCids(
    [file.cid],
    async (locked) => (await locked.registerReplacing(file, options)).record
  )
}

function record(overrides: Pick<FileRecord, 'cid' | 'state'> & Partial<FileRecord>): FileRecord {
  return {
    name: 'file',
    createdAt: 0,
    expiresAt: null,
    confirmedAt: null,
    fileSize: 0,
    storedBytes: 100,
    pinned: true,
    heldLocally: true,
    replicas: [],
    ...overrides
  }
}

/**
 * Multihash of a CID, as a hex string.
 *
 * The blockstore addresses blocks by multihash and rebuilds a CID with its own
 * default codec while listing, so a stored block can carry a different CID
 * representation than the one a file was uploaded under. Comparing digests is
 * what makes "is this block still here?" answerable.
 */
function digestOf(cid: CID | string): string {
  const parsed = typeof cid === 'string' ? CID.parse(cid) : cid
  return Buffer.from(parsed.multihash.bytes).toString('hex')
}

/** Digests of every block currently held by the blockstore. */
async function storedDigests(): Promise<Set<string>> {
  const digests = new Set<string>()
  for await (const { cid } of blockstore.getAll()) {
    digests.add(digestOf(cid))
  }
  return digests
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'ipfs-node-lifecycle-'))
  blockstore = new FsBlockstore(join(storeDir, 'blockstore'))
  datastore = new FsDatastore(join(storeDir, 'datastore'))
  await blockstore.open()
  await datastore.open()

  node = await createIpfsNode({ blockstore, datastore, listen: LISTEN })
  ifs = unixfs(node)
})

after(async () => {
  await node.stop()
  await blockstore.close()
  await datastore.close()
  await rm(storeDir, { recursive: true, force: true })
})

describe('pin helpers on a file-backed node', () => {
  it('pins once and reports a repeated pin as a no-op', async () => {
    const cid = await ifs.addBytes(deterministicBytes(64, 'pin-once'))

    assert.equal(await pinFile(node, cid), true)
    assert.equal(await pinFile(node, cid), false)
    assert.equal(await isProtected(node, cid), true)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('unpins once and reports a repeated unpin as a no-op', async () => {
    const cid = await ifs.addBytes(deterministicBytes(64, 'unpin-once'))
    await pinFile(node, cid)

    assert.equal(await unpinFile(node, cid), true)
    assert.equal(await unpinFile(node, cid), false)
    assert.equal(await isProtected(node, cid), false)
  })

  it('reports a leaf of a pinned DAG as protected but not directly pinned', async () => {
    // Larger than the 1 MiB chunk size, so the root is a dag-pb node over leaves
    const root = await ifs.addBytes(deterministicBytes(3_145_735, 'multi'))

    // `pins.add` yields every CID it walks, so the leaves come out with the root
    const walked: CID[] = []
    for await (const cid of node.pins.add(root)) {
      walked.push(cid)
    }

    const leaves = walked.filter((cid) => !cid.equals(root))
    assert.ok(leaves.length > 0, 'fixture must span more than one block')

    assert.equal(await isDirectlyPinned(node, root), true)
    assert.equal(await isDirectlyPinned(node, leaves[0]), false)
    // The leaf carries no pin of its own, yet collection must keep it
    assert.equal(await isProtected(node, leaves[0]), true)
  })
})

describe('upload session cleanup', () => {
  it('removes the blocks a rejected upload created', async () => {
    const session = createSession()
    const content = deterministicBytes(2048, 'rejected')
    const cid = await unixfs({ blockstore: session.blockstore }).addBytes(content)

    assert.equal(session.bytesWritten > 0, true)
    assert.equal(await session.cleanup(), 1)
    assert.equal(await blockstore.has(cid), false)
  })

  it('keeps the blocks of a committed upload', async () => {
    const session = createSession()
    const cid = await unixfs({ blockstore: session.blockstore }).addBytes(
      deterministicBytes(2048, 'committed')
    )

    session.commit()

    assert.equal(await session.cleanup(), 0)
    assert.equal(await blockstore.has(cid), true)
  })

  it('releases its operation lease once cleanup settles', async () => {
    let settled = 0
    const session = createSession(64 * 1024 * 1024, () => {
      settled += 1
    })
    await unixfs({ blockstore: session.blockstore }).addBytes(
      deterministicBytes(2048, 'cleanup-settles')
    )

    await session.cleanup()
    await session.cleanup()

    assert.equal(settled, 1)
  })

  it('leaves blocks that already existed before the upload', async () => {
    const content = deterministicBytes(2048, 'pre-existing')
    const cid = await ifs.addBytes(content)

    const session = createSession()
    await unixfs({ blockstore: session.blockstore }).addBytes(content)

    assert.equal(session.bytesWritten, 0)
    assert.equal(await session.cleanup(), 0)
    assert.equal(await blockstore.has(cid), true)
  })

  it('leaves blocks that became pinned in the meantime', async () => {
    const session = createSession()
    const cid = await unixfs({ blockstore: session.blockstore }).addBytes(
      deterministicBytes(2048, 'pinned-late')
    )
    await pinFile(node, cid)

    assert.equal(await session.cleanup(), 0)
    assert.equal(await blockstore.has(cid), true)
  })

  it('does not delete blocks a concurrent upload still writes', async () => {
    const content = deterministicBytes(2048, 'shared')
    const failing = createSession()
    const succeeding = createSession()

    const cid = await unixfs({ blockstore: failing.blockstore }).addBytes(content)
    await unixfs({ blockstore: succeeding.blockstore }).addBytes(content)

    assert.equal(await failing.cleanup(), 0)
    assert.equal(await blockstore.has(cid), true)

    succeeding.commit()
    assert.equal(await blockstore.has(cid), true)
  })

  it('stops a request once the aggregate budget is exhausted', () => {
    // The budget meters the multipart stream, so it is charged by the storage
    // engine rather than by an in-memory import.
    const session = createSession(1024)

    session.budget.consume(1000)
    assert.throws(() => session.budget.consume(100), /Request size limit exceeded/)
  })

  it('keeps collection outside the import-to-pin window', async () => {
    const lock = new StorageOperationLock()
    const lease = await lock.acquireShared()
    const session = createSession(64 * 1024 * 1024, () => lease.release())
    const cid = await unixfs({ blockstore: session.blockstore }).addBytes(
      deterministicBytes(3 * 1024 * 1024, 'gc-race')
    )
    let collectionStarted = false

    const collection = lock.withExclusive(async () => {
      collectionStarted = true
      await node.gc()
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(collectionStarted, false)

    await pinFile(node, cid)
    session.commit()
    await collection

    assert.equal(collectionStarted, true)
    assert.equal(await isDirectlyPinned(node, cid), true)
    assert.equal(await blockstore.has(cid), true)
  })
})

describe('upload admission wiring', () => {
  it('holds the production shared lease until the request commits', async () => {
    const lock = new StorageOperationLock()
    const admitted = await admitThrough(lock)
    let collectionStarted = false

    const collection = lock.withExclusive(async () => {
      collectionStarted = true
    })

    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal(collectionStarted, false)

    admitted.session.commit()
    await collection
    admitted.response.emit('close')

    assert.equal(collectionStarted, true)
  })

  it('keeps the lease through disconnect cleanup and removes unfinished blocks', async () => {
    const lock = new StorageOperationLock()
    const admitted = await admitThrough(lock)
    const cid = await unixfs({ blockstore: admitted.session.blockstore }).addBytes(
      deterministicBytes(2 * 1024 * 1024, 'admission-disconnect')
    )
    assert.equal(await blockstore.has(cid), true)

    admitted.response.emit('close')
    let collectionStarted = false
    const collection = lock.withExclusive(async () => {
      collectionStarted = true
    })

    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal(collectionStarted, false)

    await collection
    assert.equal(admitted.session.isSettled, true)
    assert.equal(collectionStarted, true)
    assert.equal(await blockstore.has(cid), false)
  })
})

describe('garbage collection against fixture data', () => {
  /**
   * One confirmed file, one abandoned upload, one live upload, and a block that
   * no pin protects, standing in for content cached while serving a peer.
   */
  async function createFixture(): Promise<{
    registry: FileRegistry
    cids: Record<string, string>
  }> {
    const registry = createRegistry()
    const cids: Record<string, string> = {}

    const add = async (
      label: string,
      state: FileRecord['state'],
      expiresAt: number | null
    ): Promise<void> => {
      const cid = await ifs.addBytes(deterministicBytes(1024, `${label}-${prefixCounter}`))
      await pinFile(node, cid)
      await registry.save(record({ cid: cid.toString(), state, expiresAt, storedBytes: 1024 }))
      cids[label] = cid.toString()
    }

    await add('confirmed', 'confirmed', null)
    await add('abandoned', 'temporary', 500)
    await add('live', 'temporary', 9_000_000_000_000)

    const cached = await ifs.addBytes(deterministicBytes(1024, `cached-${prefixCounter}`))
    cids.cached = cached.toString()

    return { registry, cids }
  }

  it('reports the plan without touching anything in a dry run', async () => {
    const { registry, cids } = await createFixture()
    const before = await storedDigests()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: WATERMARKS,
      blockstoreBytes: 4096,
      dryRun: true,
      now: 1000
    })

    assert.equal(report.collected, false)
    assert.deepEqual(report.releasedCids, [cids.abandoned])
    assert.deepEqual(report.repairedPins, [])
    assert.deepEqual([...(await storedDigests())].sort(), [...before].sort())
    assert.equal((await registry.get(cids.abandoned))?.state, 'temporary')
  })

  it('removes exactly the abandoned upload and the unpinned cache', async () => {
    const { registry, cids } = await createFixture()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.equal(report.collected, true)
    assert.equal(report.trigger, 'watermark')
    assert.deepEqual(report.releasedCids, [cids.abandoned])
    assert.deepEqual(report.retainedCids.sort(), [cids.confirmed, cids.live].sort())
    assert.deepEqual(report.errors, [])

    const remaining = await storedDigests()
    assert.equal(remaining.has(digestOf(cids.confirmed)), true)
    assert.equal(remaining.has(digestOf(cids.live)), true)
    assert.equal(remaining.has(digestOf(cids.abandoned)), false)
    assert.equal(remaining.has(digestOf(cids.cached)), false)

    assert.equal(await registry.get(cids.abandoned), undefined)
    assert.equal((await registry.get(cids.confirmed))?.state, 'confirmed')
  })

  it('keeps unpinned blocks on disk while there is still room', async () => {
    const { registry, cids } = await createFixture()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: WATERMARKS,
      blockstoreBytes: 4096,
      now: 1000
    })

    // The abandoned upload loses its pin, because that is policy. Its blocks and
    // the unpinned cache stay, because reclaiming them would only cost a refetch
    assert.equal(report.collected, false)
    assert.equal(report.trigger, 'none')
    assert.deepEqual(report.releasedCids, [cids.abandoned])
    assert.equal(report.removedBlocks, 0)

    const remaining = await storedDigests()
    assert.equal(remaining.has(digestOf(cids.abandoned)), true)
    assert.equal(remaining.has(digestOf(cids.cached)), true)
    assert.equal((await registry.get(cids.abandoned))?.pinned, false)
  })

  it('reclaims once free space falls into the disk reserve', async () => {
    const { registry, cids } = await createFixture()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: WATERMARKS,
      blockstoreBytes: 4096,
      availableBytes: 1024,
      reserveBytes: 4096,
      now: 1000
    })

    assert.equal(report.collected, true)
    assert.equal(report.trigger, 'disk-reserve')
    assert.equal((await storedDigests()).has(digestOf(cids.cached)), false)
  })

  it('evicts a live upload too when the blockstore is above the high watermark', async () => {
    const { registry, cids } = await createFixture()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: { highWatermarkBytes: 2048, lowWatermarkBytes: 1024 },
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.deepEqual(report.releasedCids.sort(), [cids.abandoned, cids.live].sort())
    assert.deepEqual(report.retainedCids, [cids.confirmed])

    const remaining = await storedDigests()
    assert.equal(remaining.has(digestOf(cids.confirmed)), true)
    assert.equal(remaining.has(digestOf(cids.live)), false)
  })

  it('abandons the run when a confirmed file cannot be protected', async () => {
    const { registry, cids } = await createFixture()

    // A record whose blocks are not here: its pin cannot be restored, because
    // nothing can fetch a CID nobody holds
    const unreachable = 'bafkreiapv3pyvtsdmvcqcgzvvjmayksybgcgfvkbfbbccjnisz3ndnvcam'
    await registry.save(record({ cid: unreachable, state: 'confirmed', storedBytes: 1024 }))

    const before = await storedDigests()

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      pinTimeoutMs: 1500,
      now: 1000
    })

    // Collection deletes every unpinned block, so it must not run at all while
    // a confirmed file is unprotected
    assert.deepEqual(report.unprotected, [unreachable])
    assert.equal(report.collected, false)
    assert.equal(report.removedBlocks, 0)
    assert.deepEqual([...(await storedDigests())].sort(), [...before].sort())
    assert.equal((await registry.get(cids.abandoned))?.pinned, true)

    await registry.remove(unreachable)
  })

  it('keeps every record when the collector could not delete everything', async () => {
    const { registry, cids } = await createFixture()

    // Helia resolves even after reporting a block it could not delete. Which
    // file the survivor belongs to is unknowable, so nothing may be
    // deregistered on the strength of a run that did not finish.
    const flaky = new Proxy(node, {
      get: (target, property) =>
        property === 'gc'
          ? (options?: { onProgress?: (event: unknown) => void }) => {
              options?.onProgress?.({
                type: 'helia:gc:error',
                detail: new Error('blockstore I/O error')
              })
              return Promise.resolve()
            }
          : Reflect.get(target, property, target)
    }) as IpfsNode

    const report = await runGarbageCollection({
      node: flaky,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.equal(report.collected, false)
    assert.equal(report.errors.length, 1)

    // Released, so the next run retries it — but still there to be retried.
    assert.equal((await registry.get(cids.abandoned))?.state, 'expired')
  })

  it('does not report a clean collection when registry cleanup fails', async () => {
    const { registry, cids } = await createFixture()
    const cleanupFails = new Proxy(registry, {
      get: (target, property) =>
        property === 'transition'
          ? async (): Promise<never> => {
              throw new Error('registry cleanup failed')
            }
          : Reflect.get(target, property, target)
    }) as FileRegistry

    const report = await runGarbageCollection({
      node,
      registry: cleanupFails,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.equal(report.collected, false)
    assert.ok(report.errors.some((message) => message.includes('registry cleanup failed')))
    assert.equal((await registry.get(cids.abandoned))?.state, 'expired')
  })

  it('does not reclaim a syntactically valid but structurally invalid record', async () => {
    const prefix = `/adm/invalid-lifecycle-${prefixCounter}`
    const cid = await ifs.addBytes(deterministicBytes(2048, 'invalid-lifecycle'))
    await pinFile(node, cid)
    await datastore.put(
      new Key(`${prefix}/${cid.toString()}`),
      new TextEncoder().encode(
        JSON.stringify({
          ...record({ cid: cid.toString(), state: 'confirmed' }),
          state: 'corrupted',
          revision: 1
        })
      )
    )

    const registry = new FileRegistry(datastore, prefix)
    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.deepEqual(report.releasedCids, [])
    assert.equal(await isDirectlyPinned(node, cid), true)
    assert.equal(await blockstore.has(cid), true)
    await assert.rejects(() => registry.get(cid.toString()), /Invalid lifecycle registry record/)
  })

  it('does not apply a plan the registry has moved past', async () => {
    const { registry, cids } = await createFixture()

    // The plan is made from a snapshot; an upload can re-register and confirm
    // the same CID before the run reaches the unpin
    const stale = await registry.all()
    await registerFile(
      registry,
      { cid: cids.abandoned, name: 'again.bin', fileSize: 1024, storedBytes: 1024 },
      { confirmationRequired: false, temporaryTtlMs: 60_000 }
    )

    const planned = new Proxy(registry, {
      get: (target, property) =>
        property === 'all'
          ? async (): Promise<FileRecord[]> => stale
          : Reflect.get(target, property, target)
    }) as FileRegistry

    const report = await runGarbageCollection({
      node,
      registry: planned,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.deepEqual(report.releasedCids, [])
    assert.equal((await registry.get(cids.abandoned))?.state, 'confirmed')
    assert.equal(await isProtected(node, CID.parse(cids.abandoned)), true)
    assert.equal((await storedDigests()).has(digestOf(cids.abandoned)), true)
  })

  it('does not apply an expired plan to a new temporary upload', async () => {
    const { registry, cids } = await createFixture()
    const stale = await registry.all()
    const fresh = await registerFile(
      registry,
      { cid: cids.abandoned, name: 'new-upload.bin', fileSize: 1024, storedBytes: 1024 },
      { confirmationRequired: true, temporaryTtlMs: 60_000, now: 2000 }
    )

    const planned = new Proxy(registry, {
      get: (target, property) =>
        property === 'all'
          ? async (): Promise<FileRecord[]> => stale
          : Reflect.get(target, property, target)
    }) as FileRegistry

    const report = await runGarbageCollection({
      node,
      registry: planned,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 2000
    })

    const current = await registry.get(cids.abandoned)
    assert.deepEqual(report.releasedCids, [])
    assert.equal(current?.revision, fresh.revision)
    assert.equal(current?.state, 'temporary')
    assert.equal(await isProtected(node, CID.parse(cids.abandoned)), true)
  })

  it('does not remove a record re-created while blocks were being deleted', async () => {
    const { registry, cids } = await createFixture()

    // Deleting blocks takes time, and a re-upload can pin and register the same
    // CID while it runs
    const racing = new Proxy(node, {
      get: (target, property) =>
        property === 'gc'
          ? async (): Promise<void> => {
              await pinFile(node, CID.parse(cids.abandoned))
              await registerFile(
                registry,
                { cid: cids.abandoned, name: 'again.bin', fileSize: 1024, storedBytes: 1024 },
                { confirmationRequired: false, temporaryTtlMs: 1000 }
              )
            }
          : Reflect.get(target, property, target)
    }) as IpfsNode

    await runGarbageCollection({
      node: racing,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: TIGHT,
      blockstoreBytes: 4096,
      now: 1000
    })

    const record = await registry.get(cids.abandoned)
    assert.equal(record?.state, 'confirmed')
    assert.equal(record?.name, 'again.bin')
    assert.equal(await isProtected(node, CID.parse(cids.abandoned)), true)
  })

  it('restores a missing pin on confirmed content before deleting anything', async () => {
    const { registry, cids } = await createFixture()
    await unpinFile(node, CID.parse(cids.confirmed))

    const report = await runGarbageCollection({
      node,
      registry,
      withCollectionLease: runWithoutOtherWriters,
      watermarks: WATERMARKS,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.deepEqual(report.repairedPins, [cids.confirmed])
    assert.equal(await isProtected(node, CID.parse(cids.confirmed)), true)
    assert.equal((await storedDigests()).has(digestOf(cids.confirmed)), true)
  })
})

describe('block metering', () => {
  it('charges the structural blocks a UnixFS stream never yields', async () => {
    // Counting the stream measures the file; counting blocks measures what
    // crossed the network. A DAG-PB root and its links are real bytes that a
    // reader of the content alone never sees. Large enough to be chunked, so
    // the DAG has a root above its leaves at all.
    const payload = deterministicBytes(4 * 1024 * 1024, 'metered')
    const cid = await ifs.addBytes(payload)

    const progress = { bytes: 0 }
    const metered = unixfs({
      blockstore: meteredBlocks(node.blockstore, progress, 16 * 1024 * 1024)
    })

    let streamed = 0
    for await (const chunk of metered.cat(cid)) {
      streamed += chunk.byteLength
    }

    assert.equal(streamed, payload.byteLength)
    assert.ok(
      progress.bytes > streamed,
      `metered ${progress.bytes} bytes, which must exceed the ${streamed} bytes of content`
    )
  })

  it('stops a walk that outgrows the limit instead of finishing it', async () => {
    const limit = 2 * 1024 * 1024
    const payload = deterministicBytes(16 * 1024 * 1024, 'metered-limit')
    const cid = await ifs.addBytes(payload)
    const progress = { bytes: 0 }
    const metered = unixfs({ blockstore: meteredBlocks(node.blockstore, progress, limit) })

    // Without a bound on how many blocks are read at a time the exporter
    // requests the whole DAG before a single byte can be counted, and the limit
    // bounds nothing
    const readOptions = {
      signal: AbortSignal.timeout(30_000),
      blockReadConcurrency: INTAKE_READ_CONCURRENCY
    }

    await assert.rejects(async () => {
      for await (const chunk of metered.cat(cid, readOptions)) {
        void chunk
      }
    }, /larger than this node accepts/)

    assert.ok(
      progress.bytes <= limit + INTAKE_OVERSHOOT_BYTES,
      `metered ${progress.bytes} bytes, past the ${limit + INTAKE_OVERSHOOT_BYTES} the reservation covers`
    )
  })

  it('covers large in-flight blocks with the advertised overshoot', async () => {
    const limit = 1024 * 1024
    const payload = deterministicBytes(15 * 1024 * 1024, 'large-metered-blocks')
    const cid = await ifs.addBytes(payload, {
      chunker: fixedSize({ chunkSize: 3 * 1024 * 1024 })
    })
    const progress = { bytes: 0 }
    const metered = unixfs({ blockstore: meteredBlocks(node.blockstore, progress, limit) })
    const readOptions = {
      signal: AbortSignal.timeout(30_000),
      blockReadConcurrency: INTAKE_READ_CONCURRENCY
    }

    await assert.rejects(async () => {
      for await (const chunk of metered.cat(cid, readOptions)) {
        void chunk
      }
    }, /larger than this node accepts/)

    assert.ok(
      progress.bytes <= limit + INTAKE_OVERSHOOT_BYTES,
      `metered ${progress.bytes} bytes, past the reserved ${limit + INTAKE_OVERSHOOT_BYTES}`
    )
  })
})

describe('multipart import', () => {
  it('reports the size of the part it imported', async () => {
    // Nothing else knows it. Multer fills `size` only for engines that report
    // it, and the blocks written are a different number — re-uploading content
    // this node already holds writes none at all. Leaving it unset produced
    // lifecycle records without a file size, which the registry cannot read.
    const session = createSession()
    const storage = new UnixfsMulterStorage({ getSession: () => session })
    const payload = deterministicBytes(140_000, 'multipart-size')

    const imported = await new Promise<Partial<UnixFsMulterFile>>((resolve, reject) => {
      storage._handleFile(
        {} as unknown as Request,
        { originalname: 'photo.jpg', stream: Readable.from([payload]) } as Express.Multer.File,
        (err, info) => (err ? reject(err) : resolve(info as Partial<UnixFsMulterFile>))
      )
    })

    assert.equal(imported.size, payload.byteLength)
    assert.notEqual(imported.cid, undefined)
    assert.ok((imported.storedBytes ?? 0) > 0)
  })

  it('reports a size even when the content was already stored', async () => {
    const payload = deterministicBytes(90_000, 'multipart-known')
    await ifs.addBytes(payload)

    const session = createSession()
    const storage = new UnixfsMulterStorage({ getSession: () => session })

    const imported = await new Promise<Partial<UnixFsMulterFile>>((resolve, reject) => {
      storage._handleFile(
        {} as unknown as Request,
        { originalname: 'again.jpg', stream: Readable.from([payload]) } as Express.Multer.File,
        (err, info) => (err ? reject(err) : resolve(info as Partial<UnixFsMulterFile>))
      )
    })

    // No new blocks, but the file still has a size
    assert.equal(imported.storedBytes, 0)
    assert.equal(imported.size, payload.byteLength)
    assert.ok(
      (imported.protectedBytes ?? 0) > 0,
      'an existing DAG still contributes bytes protected by its pin'
    )
  })
})

describe('collection pass', () => {
  const watermarks = { highWatermarkBytes: 0, lowWatermarkBytes: 0 }

  async function withoutExclusiveWait<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('collection waited for the shared lease')), 1000)
    })

    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  function pass(
    lock: StorageOperationLock,
    registry: FileRegistry,
    overrides: Partial<Parameters<typeof collectStorage>[0]> = {}
  ): Promise<{ demoted: string[]; collected: boolean }> {
    return collectStorage({
      lock,
      node,
      registry,
      watermarks,
      reserveBytes: 0,
      demote: async () => ({ demoted: [] }),
      measure: async () => ({ blockstoreBytes: 0, availableBytes: 1_000_000_000 }),
      force: true,
      ...overrides
    })
  }

  it('waits for an upload before Helia starts deleting blocks', async () => {
    // The lease has to be taken by the pass itself. Testing the lock alone
    // leaves the wiring free to disappear without a test noticing. Planning is
    // allowed to finish; the injected `gc` marks the exact destructive edge.
    const lock = new StorageOperationLock()
    const registry = createRegistry()
    const lease = await lock.acquireShared()
    let deletionStarted = false
    let measured: (() => void) | undefined
    const measurementFinished = new Promise<void>((resolve) => {
      measured = resolve
    })
    const collectingNode = {
      gc: async (): Promise<void> => {
        deletionStarted = true
      }
    } as IpfsNode

    const collection = pass(lock, registry, {
      node: collectingNode,
      measure: async () => {
        measured?.()
        return { blockstoreBytes: 0, availableBytes: 1_000_000_000 }
      }
    })

    await measurementFinished
    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    assert.equal(deletionStarted, false, 'Helia GC must wait while an upload holds its lease')

    lease.release()
    await collection

    assert.equal(deletionStarted, true)
  })

  it('does not take the exclusive lease for a dry run', async () => {
    const lock = new StorageOperationLock()
    const lease = await lock.acquireShared()

    try {
      const report = await withoutExclusiveWait(pass(lock, createRegistry(), { dryRun: true }))
      assert.equal(report.collected, false)
    } finally {
      lease.release()
    }
  })

  it('does not take the exclusive lease when no deletion is needed', async () => {
    const lock = new StorageOperationLock()
    const lease = await lock.acquireShared()

    try {
      const report = await withoutExclusiveWait(pass(lock, createRegistry(), { force: false }))
      assert.equal(report.collected, false)
    } finally {
      lease.release()
    }
  })

  it('asks peers before taking the lease, not while holding it', async () => {
    // Handover probes wait for the network. Inside the lease they would hold
    // every upload on the node for as long as the slowest peer takes to answer.
    const lock = new StorageOperationLock()
    const registry = createRegistry()
    let heldDuringDemote: boolean | undefined

    await pass(lock, registry, {
      demote: async () => {
        // A shared lease can only be taken while the pass does not hold the
        // exclusive one
        const probe = await lock.acquireShared()
        heldDuringDemote = true
        probe.release()
        return { demoted: ['handed-over'] }
      }
    })

    assert.equal(heldDuringDemote, true)
  })

  it('reports what the handover released alongside the collection', async () => {
    const lock = new StorageOperationLock()
    const report = await pass(lock, createRegistry(), {
      demote: async () => ({ demoted: ['a', 'b'] })
    })

    assert.deepEqual(report.demoted, ['a', 'b'])
  })
})

describe('lifecycle transitions', () => {
  const TTL = 60_000

  /** A registry whose datastore write always fails, to exercise compensation. */
  function unwritable(registry: FileRegistry): FileRegistry {
    return new Proxy(registry, {
      get: (target, property) =>
        property === 'save'
          ? async (): Promise<never> => {
              throw new Error('datastore is unavailable')
            }
          : Reflect.get(target, property, target)
    }) as FileRegistry
  }

  /** A registry whose next save lands but reports failure to its caller. */
  function failsAfterNextSave(registry: FileRegistry): FileRegistry {
    let fail = true

    return new Proxy(registry, {
      get: (target, property) => {
        if (property !== 'save') {
          return Reflect.get(target, property, target)
        }

        return async (value: FileRecord): Promise<FileRecord> => {
          const stored = await target.save(value)

          if (fail) {
            fail = false
            throw new Error('datastore acknowledgement failed')
          }

          return stored
        }
      }
    }) as FileRegistry
  }

  it('adopts an unknown CID only when asked to', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'confirm-unknown'))

    const ignored = await confirmStoredFile({
      node,
      registry,
      unixfs: ifs,
      cid,
      temporaryTtlMs: TTL
    })

    assert.equal(ignored, undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)

    const adopted = await confirmStoredFile({
      node,
      registry,
      unixfs: ifs,
      cid,
      registerUnknown: true,
      temporaryTtlMs: TTL
    })

    assert.equal(adopted?.state, 'confirmed')
    assert.equal(adopted?.pinned, true)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('confirms a temporary file, clears its expiry and pins it', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'confirm-temporary'))
    await registry.save(
      record({ cid: cid.toString(), state: 'temporary', expiresAt: 9000, pinned: false })
    )

    const confirmed = await confirmStoredFile({
      node,
      registry,
      unixfs: ifs,
      cid,
      temporaryTtlMs: TTL,
      now: 5000
    })

    assert.equal(confirmed?.state, 'confirmed')
    assert.equal(confirmed?.expiresAt, null)
    assert.equal(confirmed?.confirmedAt, 5000)
    assert.equal(confirmed?.pinned, true)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('passes the configured timeout to a known CID pin', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'confirm-timeout'))
    await registry.save(
      record({ cid: cid.toString(), state: 'temporary', expiresAt: 9000, pinned: false })
    )
    let receivedSignal: AbortSignal | undefined
    const fakeNode = {
      pins: {
        get: async (): Promise<never> => {
          const error = new Error('not pinned')
          error.name = 'NotFoundError'
          throw error
        },
        add: async function* (_cid: CID, options?: { signal?: AbortSignal }): AsyncGenerator<CID> {
          receivedSignal = options?.signal
          yield cid
        }
      }
    } as unknown as IpfsNode

    await confirmStoredFile({
      node: fakeNode,
      registry,
      unixfs: ifs,
      cid,
      temporaryTtlMs: TTL,
      pinTimeoutMs: 30_000
    })

    assert.ok(receivedSignal instanceof AbortSignal)
    assert.equal(receivedSignal.aborted, false)
  })

  it('removes the pin it created when confirmation cannot be recorded', async () => {
    // A record claiming durability for content the blockstore does not protect
    // is the one outcome this must never leave behind
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'confirm-fails'))
    await registry.save(
      record({ cid: cid.toString(), state: 'temporary', expiresAt: 9000, pinned: false })
    )

    await assert.rejects(
      () =>
        confirmStoredFile({
          node,
          registry: unwritable(registry),
          unixfs: ifs,
          cid,
          temporaryTtlMs: TTL
        }),
      /datastore is unavailable/
    )

    assert.equal(await isDirectlyPinned(node, cid), false)
    assert.equal((await registry.get(cid.toString()))?.state, 'temporary')
  })

  it('restores confirmation state when a failed save actually landed', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'confirm-after-write'))
    await registry.save(
      record({ cid: cid.toString(), state: 'temporary', expiresAt: 9000, pinned: false })
    )

    await assert.rejects(
      () =>
        confirmStoredFile({
          node,
          registry: failsAfterNextSave(registry),
          unixfs: ifs,
          cid,
          temporaryTtlMs: TTL
        }),
      /datastore acknowledgement failed/
    )

    const restored = await registry.get(cid.toString())
    assert.equal(restored?.state, 'temporary')
    assert.equal(restored?.expiresAt, 9000)
    assert.equal(restored?.pinned, false)
    assert.equal(restored?.heldLocally, true)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('removes a new record when registration failed after writing it', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'register-after-write'))

    await assert.rejects(
      () =>
        registerPinnedFile({
          node,
          registry: failsAfterNextSave(registry),
          unixfs: ifs,
          cid,
          temporaryTtlMs: TTL
        }),
      /datastore acknowledgement failed/
    )

    assert.equal(await registry.get(cid.toString()), undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('releases a registered file and removes its pin', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'release-known'))
    await registerPinnedFile({ node, registry, unixfs: ifs, cid, temporaryTtlMs: TTL })

    const released = await releaseStoredFile({ node, registry, cid })

    assert.equal(released?.state, 'expired')
    assert.equal(released?.pinned, false)
    assert.equal(released?.heldLocally, false)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('leaves a CID the registry does not know alone', async () => {
    // Startup records every pin, so an unknown CID is either unpinned or not
    // reconciled yet — and that window is exactly when unpinning would drop
    // protection from content older than the registry
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'release-unknown'))
    await pinFile(node, cid)

    assert.equal(await releaseStoredFile({ node, registry, cid }), undefined)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('restores the pin when the release cannot be recorded', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'release-fails'))
    await registerPinnedFile({ node, registry, unixfs: ifs, cid, temporaryTtlMs: TTL })

    await assert.rejects(
      () => releaseStoredFile({ node, registry: unwritable(registry), cid }),
      /datastore is unavailable/
    )

    // The record still promises protection, so the protection has to be there
    assert.equal((await registry.get(cid.toString()))?.pinned, true)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('restores release state when a failed save actually landed', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'release-after-write'))
    await registerPinnedFile({ node, registry, unixfs: ifs, cid, temporaryTtlMs: TTL })

    await assert.rejects(
      () => releaseStoredFile({ node, registry: failsAfterNextSave(registry), cid }),
      /datastore acknowledgement failed/
    )

    const restored = await registry.get(cid.toString())
    assert.equal(restored?.state, 'confirmed')
    assert.equal(restored?.pinned, true)
    assert.equal(restored?.heldLocally, true)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })
})

describe('strict-upload replica staging', () => {
  const stage = (registry: FileRegistry, cid: CID, transactionId: string, now = 1000) =>
    stageReplica({
      node,
      unixfs: ifs,
      registry,
      cid,
      transactionId,
      temporaryTtlMs: 1000,
      now
    })

  it('removes a new prepared copy when its transaction aborts', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(20_000, 'replica-stage-abort'))

    const prepared = await stage(registry, cid, 'tx-abort')

    assert.equal(prepared.staged, true)
    assert.equal(prepared.record.state, 'temporary')
    assert.deepEqual(prepared.record.replicaStage?.transactionIds, ['tx-abort'])
    assert.equal(await isDirectlyPinned(node, cid), true)

    await abortReplica({ node, registry, cid, transactionId: 'tx-abort' })

    assert.equal(await registry.get(cid.toString()), undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('keeps a shared stage until one transaction commits it', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_000, 'replica-stage-shared'))

    await stage(registry, cid, 'tx-one')
    await stage(registry, cid, 'tx-two')
    await abortReplica({ node, registry, cid, transactionId: 'tx-one' })

    assert.deepEqual((await registry.get(cid.toString()))?.replicaStage?.transactionIds, ['tx-two'])
    assert.equal(await isDirectlyPinned(node, cid), true)

    await commitReplica({ node, registry, cid, transactionId: 'tx-two', now: 3000 })

    const committed = await registry.get(cid.toString())
    assert.equal(committed?.state, 'confirmed')
    assert.equal(committed?.replicaStage, undefined)
    assert.equal(committed?.confirmedAt, 3000)
    assert.equal(await isDirectlyPinned(node, cid), true)
  })

  it('does not unpin a shared stage when a second claim fails to persist', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_500, 'replica-stage-join-fail'))

    await stage(registry, cid, 'tx-one')
    await unpinFile(node, cid)

    let fail = true
    const failing = new Proxy(registry, {
      get: (target, property) => {
        if (property !== 'save') {
          return Reflect.get(target, property, target)
        }

        return async (value: FileRecord): Promise<FileRecord> => {
          const stored = await target.save(value)

          if (fail) {
            fail = false
            throw new Error('datastore acknowledgement failed')
          }

          return stored
        }
      }
    }) as FileRegistry

    await assert.rejects(
      () =>
        stageReplica({
          node,
          unixfs: ifs,
          registry: failing,
          cid,
          transactionId: 'tx-two',
          temporaryTtlMs: 1000,
          now: 2000
        }),
      /datastore acknowledgement failed/
    )

    assert.equal(await isDirectlyPinned(node, cid), true)
    assert.deepEqual((await registry.get(cid.toString()))?.replicaStage?.transactionIds, ['tx-one'])
  })

  it('does not confirm a prepared replica through a permanent store', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_600, 'replica-stage-store'))

    await stage(registry, cid, 'tx-live')
    const stored = await registerPinnedFile({
      node,
      registry,
      unixfs: ifs,
      cid,
      temporaryTtlMs: 60_000
    })

    assert.equal(stored.state, 'temporary')
    assert.deepEqual(stored.replicaStage?.transactionIds, ['tx-live'])
    await abortReplica({ node, registry, cid, transactionId: 'tx-live' })
    assert.equal(await registry.get(cid.toString()), undefined)
  })

  it('rejects manual confirm and release while a replica transaction is live', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_650, 'replica-stage-admin'))

    await stage(registry, cid, 'tx-admin')

    await assert.rejects(
      () =>
        confirmStoredFile({
          node,
          registry,
          unixfs: ifs,
          cid,
          temporaryTtlMs: 60_000
        }),
      /active lifecycle transaction/
    )
    await assert.rejects(
      () => releaseStoredFile({ node, registry, cid }),
      /active lifecycle transaction/
    )

    assert.deepEqual((await registry.get(cid.toString()))?.replicaStage?.transactionIds, [
      'tx-admin'
    ])
    assert.equal(await isDirectlyPinned(node, cid), true)

    await abortReplica({ node, registry, cid, transactionId: 'tx-admin' })
  })

  it('does not count an unsettled local upload as a stable replica', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_700, 'replica-stage-admission'))
    await pinFile(node, cid)
    await registry.save({
      cid: cid.toString(),
      name: cid.toString(),
      state: 'confirmed',
      createdAt: 1000,
      expiresAt: null,
      confirmedAt: 1000,
      fileSize: 21_700,
      storedBytes: 21_700,
      protectedBytes: 21_700,
      pinned: true,
      heldLocally: true,
      replicas: [],
      admissionId: 'mine'
    })

    await assert.rejects(() => stage(registry, cid, 'tx-other'), /unsettled local upload/)

    assert.equal((await registry.get(cid.toString()))?.admissionId, 'mine')
    assert.equal((await registry.get(cid.toString()))?.replicaStage, undefined)
  })

  it('accepts a settled upload whose admission token cleanup is pending', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_800, 'replica-stage-settled-admission'))
    await pinFile(node, cid)
    await registry.save({
      cid: cid.toString(),
      name: cid.toString(),
      state: 'confirmed',
      createdAt: 1000,
      expiresAt: null,
      confirmedAt: 1000,
      fileSize: 21_800,
      storedBytes: 21_800,
      protectedBytes: 21_800,
      pinned: true,
      heldLocally: true,
      replicas: [],
      admissionId: 'settled',
      admissionSettledAt: 2000
    })

    const result = await stage(registry, cid, 'tx-other')

    assert.equal(result.staged, false)
    assert.equal((await registry.get(cid.toString()))?.admissionId, 'settled')
  })

  it('rejects a stage that arrives after its abort', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_900, 'replica-stage-late'))

    await abortReplica({
      node,
      registry,
      cid,
      transactionId: 'tx-late',
      tombstoneTtlMs: 1000,
      now: 1000
    })

    await assert.rejects(() => stage(registry, cid, 'tx-late', 1500), /already aborted/)
    assert.equal(await registry.get(cid.toString()), undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('does not acknowledge commit after a stage disappeared', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(21_950, 'replica-stage-missing-commit'))

    await assert.rejects(
      () => commitReplica({ node, registry, cid, transactionId: 'tx-missing' }),
      /is not staged/
    )
  })

  it('restores an expired record after a prepared copy aborts', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(22_000, 'replica-stage-restore'))
    const previous = await registry.save({
      cid: cid.toString(),
      name: 'released.bin',
      state: 'expired',
      createdAt: 100,
      expiresAt: 200,
      confirmedAt: 150,
      fileSize: 22_000,
      storedBytes: 22_000,
      protectedBytes: 22_000,
      pinned: false,
      heldLocally: false,
      replicas: ['old-holder']
    })

    await stage(registry, cid, 'tx-restore')
    await abortReplica({ node, registry, cid, transactionId: 'tx-restore' })

    const restored = await registry.get(cid.toString())
    assert.equal(restored?.state, previous.state)
    assert.equal(restored?.expiresAt, previous.expiresAt)
    assert.equal(restored?.confirmedAt, previous.confirmedAt)
    assert.equal(restored?.name, previous.name)
    assert.deepEqual(restored?.replicas, previous.replicas)
    assert.equal(restored?.replicaStage, undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('expires a stage left behind by a disappeared coordinator', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(23_000, 'replica-stage-expiry'))

    await stage(registry, cid, 'tx-lost', 1000)
    await runGarbageCollection({
      node,
      registry,
      watermarks: WATERMARKS,
      blockstoreBytes: 23_000,
      now: 2001,
      withCollectionLease: runWithoutOtherWriters
    })

    const expired = await registry.get(cid.toString())
    assert.equal(expired?.state, 'expired')
    assert.equal(expired?.replicaStage, undefined)
    assert.equal(await isDirectlyPinned(node, cid), false)
  })

  it('keeps a live stage pinned while collection runs under pressure', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(24_000, 'replica-stage-pressure'))

    await stage(registry, cid, 'tx-active', 1000)
    const report = await runGarbageCollection({
      node,
      registry,
      watermarks: { highWatermarkBytes: 1, lowWatermarkBytes: 0 },
      blockstoreBytes: 24_000,
      now: 1500,
      withCollectionLease: runWithoutOtherWriters
    })

    const prepared = await registry.get(cid.toString())
    assert.equal(report.collected, true)
    assert.deepEqual(report.releasedCids, [])
    assert.equal(prepared?.state, 'temporary')
    assert.deepEqual(prepared?.replicaStage?.transactionIds, ['tx-active'])
    assert.equal(await isDirectlyPinned(node, cid), true)
  })
})

describe('registry backfill', () => {
  it('records a pin that predates the registry, and does so only once', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'legacy-pin'))
    await pinFile(node, cid)

    const first = await backfillRegistryFromPins({
      cids: await snapshotPins(node),
      unixfs: ifs,
      registry
    })
    const recorded = await registry.get(cid.toString())

    assert.ok(first.registered > 0)
    assert.equal(recorded?.state, 'confirmed')
    assert.equal(recorded?.heldLocally, true)
    assert.ok((recorded?.storedBytes ?? 0) > 0)

    const second = await backfillRegistryFromPins({
      cids: await snapshotPins(node),
      unixfs: ifs,
      registry
    })
    assert.equal(second.registered, 0)
    assert.ok(second.known > 0)
  })

  it('ignores a pin created after the snapshot was taken', async () => {
    // A pin made once the API is serving belongs to a request with a lifecycle
    // of its own, and must not be recorded as legacy content
    const registry = createRegistry()
    const before = await ifs.addBytes(deterministicBytes(2048, 'snapshot-before'))
    await pinFile(node, before)

    const cids = await snapshotPins(node)

    const after = await ifs.addBytes(deterministicBytes(2048, 'snapshot-after'))
    await pinFile(node, after)

    await backfillRegistryFromPins({ cids, unixfs: ifs, registry })

    assert.notEqual(await registry.get(before.toString()), undefined)
    assert.equal(await registry.get(after.toString()), undefined)
  })

  it('reports a registry failure as an error rather than as incomplete content', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'unwritable'))
    await pinFile(node, cid)

    // A datastore that is unavailable says nothing about whether the DAG is
    // local, and reporting it as incomplete sends an operator after the wrong
    // problem entirely.
    const failing = {
      get: (value: string) => registry.get(value),
      save: () => Promise.reject(new Error('datastore is unavailable'))
    } as unknown as FileRegistry

    const report = await backfillRegistryFromPins({
      cids: await snapshotPins(node),
      unixfs: ifs,
      registry: failing
    })

    assert.equal(report.incomplete, 0)
    assert.ok(report.errors.some((message) => message.includes(cid.toString())))
    assert.equal(await registry.get(cid.toString()), undefined)
  })

  it('leaves an existing record untouched', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'already-known'))
    await pinFile(node, cid)
    await registry.save(record({ cid: cid.toString(), state: 'confirmed', name: 'mine.bin' }))

    await backfillRegistryFromPins({ cids: await snapshotPins(node), unixfs: ifs, registry })

    assert.equal((await registry.get(cid.toString()))?.name, 'mine.bin')
  })
})
