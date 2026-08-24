import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { CID } from 'multiformats/cid'
import { createIpfsNode, type IpfsNode } from '../../src/ipfs-node.js'
import { backfillRegistryFromPins } from '../../src/storage/backfill.js'
import { runGarbageCollection } from '../../src/storage/gc.js'
import { isDirectlyPinned, isProtected, pinFile, unpinFile } from '../../src/storage/pinning.js'
import { FileRegistry, type FileRecord } from '../../src/storage/registry.js'
import { UploadSession } from '../../src/storage/uploadSession.js'
import { deterministicBytes } from '../fixtures.js'

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

function createSession(maxRequestSizeBytes = 64 * 1024 * 1024): UploadSession {
  return new UploadSession({
    blockstore: node.blockstore,
    isPinned: (cid) => node.pins.isPinned(cid),
    deleteBlock: (cid) => blockstore.delete(cid),
    maxRequestSizeBytes,
    parseCid: (value) => CID.parse(value),
    onCleanupError: (err) => assert.fail(`unexpected cleanup error: ${err.message}`)
  })
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

  it('restores a missing pin on confirmed content before deleting anything', async () => {
    const { registry, cids } = await createFixture()
    await unpinFile(node, CID.parse(cids.confirmed))

    const report = await runGarbageCollection({
      node,
      registry,
      watermarks: WATERMARKS,
      blockstoreBytes: 4096,
      now: 1000
    })

    assert.deepEqual(report.repairedPins, [cids.confirmed])
    assert.equal(await isProtected(node, CID.parse(cids.confirmed)), true)
    assert.equal((await storedDigests()).has(digestOf(cids.confirmed)), true)
  })
})

describe('registry backfill', () => {
  it('records a pin that predates the registry, and does so only once', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'legacy-pin'))
    await pinFile(node, cid)

    const first = await backfillRegistryFromPins({ node, unixfs: ifs, registry })
    const recorded = await registry.get(cid.toString())

    assert.ok(first.registered > 0)
    assert.equal(recorded?.state, 'confirmed')
    assert.equal(recorded?.heldLocally, true)
    assert.ok((recorded?.storedBytes ?? 0) > 0)

    const second = await backfillRegistryFromPins({ node, unixfs: ifs, registry })
    assert.equal(second.registered, 0)
    assert.ok(second.known > 0)
  })

  it('leaves an existing record untouched', async () => {
    const registry = createRegistry()
    const cid = await ifs.addBytes(deterministicBytes(2048, 'already-known'))
    await pinFile(node, cid)
    await registry.save(record({ cid: cid.toString(), state: 'confirmed', name: 'mine.bin' }))

    await backfillRegistryFromPins({ node, unixfs: ifs, registry })

    assert.equal((await registry.get(cid.toString()))?.name, 'mine.bin')
  })
})
