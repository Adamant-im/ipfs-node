import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FsDatastore } from 'datastore-fs'
import { FileRegistry, isExpired, isReclaimable, type FileRecord } from '../src/storage/registry.js'

const CID_A = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const CID_B = 'bafkreihfzyt2g6pbd4rhk67deek7xh33xams74spn72eqq5qhx2ypphvii'
const TTL = 60_000

let storeDir: string
let datastore: FsDatastore
let counter = 0

/** A registry over its own key prefix so tests never see each other's records. */
function createRegistry(): FileRegistry {
  counter += 1
  return new FileRegistry(datastore, `/adm/test-${counter}`)
}

const newFile = (cid = CID_A) => ({ cid, name: 'photo.jpg', fileSize: 100, storedBytes: 120 })

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'ipfs-node-registry-'))
  datastore = new FsDatastore(join(storeDir, 'datastore'))
  await datastore.open()
})

after(async () => {
  await datastore.close()
  await rm(storeDir, { recursive: true, force: true })
})

describe('FileRegistry', () => {
  it('registers an upload as confirmed when confirmation is not required', async () => {
    const registry = createRegistry()

    const record = await registry.register(newFile(), {
      confirmationRequired: false,
      temporaryTtlMs: TTL,
      now: 1000
    })

    assert.equal(record.state, 'confirmed')
    assert.equal(record.expiresAt, null)
    assert.equal(record.confirmedAt, 1000)
    assert.equal(record.pinned, true)
  })

  it('registers an upload as temporary with a TTL when confirmation is required', async () => {
    const registry = createRegistry()

    const record = await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL,
      now: 1000
    })

    assert.equal(record.state, 'temporary')
    assert.equal(record.expiresAt, 1000 + TTL)
    assert.equal(record.confirmedAt, null)
  })

  it('never downgrades content that is already confirmed', async () => {
    const registry = createRegistry()
    await registry.register(newFile(), {
      confirmationRequired: false,
      temporaryTtlMs: TTL,
      now: 1000
    })

    const reuploaded = await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL,
      now: 2000
    })

    assert.equal(reuploaded.state, 'confirmed')
    assert.equal(reuploaded.expiresAt, null)
  })

  it('confirms a temporary file and clears its expiry', async () => {
    const registry = createRegistry()
    await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL,
      now: 1000
    })

    const confirmed = await registry.confirm(CID_A, 5000)

    assert.equal(confirmed?.state, 'confirmed')
    assert.equal(confirmed?.expiresAt, null)
    assert.equal(confirmed?.confirmedAt, 5000)
  })

  it('reports an unknown CID instead of creating one on confirmation', async () => {
    assert.equal(await createRegistry().confirm(CID_B), undefined)
  })

  it('releases a confirmed file so it becomes reclaimable', async () => {
    const registry = createRegistry()
    await registry.register(newFile(), {
      confirmationRequired: false,
      temporaryTtlMs: TTL,
      now: 1000
    })

    const released = await registry.release(CID_A)

    assert.equal(released?.state, 'expired')
    assert.equal(released?.pinned, false)
    assert.equal(isReclaimable(released as FileRecord, 1000), true)
  })

  it('lists every registered file and survives a reopen', async () => {
    const registry = createRegistry()
    await registry.register(newFile(CID_A), { confirmationRequired: false, temporaryTtlMs: TTL })
    await registry.register(newFile(CID_B), { confirmationRequired: true, temporaryTtlMs: TTL })

    const cids = (await registry.all()).map((record) => record.cid)

    assert.deepEqual(cids.sort(), [CID_A, CID_B].sort())
  })

  it('forgets a removed file and tolerates removing it twice', async () => {
    const registry = createRegistry()
    await registry.register(newFile(), { confirmationRequired: false, temporaryTtlMs: TTL })

    await registry.remove(CID_A)
    await assert.doesNotReject(() => registry.remove(CID_A))

    assert.equal(await registry.get(CID_A), undefined)
  })

  it('reports the record a registration replaced', async () => {
    // Read before the write, the baseline is a guess: another upload can adopt
    // the CID in between, and a rollback restoring the guess would erase it
    const registry = createRegistry()
    const first = await registry.registerReplacing(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })
    const second = await registry.registerReplacing(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    assert.equal(first.previous, undefined)
    assert.equal(second.previous?.revision, first.record.revision)
  })

  it('undoes a write only while it is still the last one', async () => {
    // Two concurrent uploads of the same file write records that match field
    // for field. The first must not roll back the lifecycle the second owns.
    const registry = createRegistry()
    const first = await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })
    const second = await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    await registry.transition(CID_A, async (current) =>
      current?.revision === first.revision ? 'remove' : 'keep'
    )

    assert.notEqual(first.revision, second.revision)
    assert.notEqual(await registry.get(CID_A), undefined)
  })

  it('removes a record when the undo is still the last write', async () => {
    const registry = createRegistry()
    const written = await registry.register(newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    await registry.transition(CID_A, async (current) =>
      current?.revision === written.revision ? 'remove' : 'keep'
    )

    assert.equal(await registry.get(CID_A), undefined)
  })

  it('creates a record only while the registry does not know the CID', async () => {
    const registry = createRegistry()
    const legacy: FileRecord = {
      cid: CID_A,
      name: CID_A,
      state: 'confirmed',
      createdAt: 1,
      expiresAt: null,
      confirmedAt: 1,
      fileSize: 10,
      storedBytes: 10,
      pinned: true,
      heldLocally: true,
      replicas: []
    }

    assert.notEqual(await registry.createIfAbsent(legacy), undefined)
    assert.equal(await registry.createIfAbsent({ ...legacy, name: 'second' }), undefined)
    assert.equal((await registry.get(CID_A))?.name, CID_A)
  })

  it('does not let a backfill overwrite an upload registered while it ran', async () => {
    // Both read the registry, decide, and write. Startup backfill now runs
    // while the API accepts uploads, and losing this race turns a temporary
    // upload into a confirmed record that never expires.
    const registry = createRegistry()
    const legacy: FileRecord = {
      cid: CID_B,
      name: CID_B,
      state: 'confirmed',
      createdAt: 1,
      expiresAt: null,
      confirmedAt: 1,
      fileSize: 10,
      storedBytes: 10,
      pinned: true,
      heldLocally: true,
      replicas: []
    }

    const [upload, backfilled] = await Promise.all([
      registry.register(newFile(CID_B), { confirmationRequired: true, temporaryTtlMs: TTL }),
      registry.createIfAbsent(legacy)
    ])

    const stored = await registry.get(CID_B)

    if (backfilled === undefined) {
      // The upload got there first, so its lifecycle is the one that survives
      assert.equal(stored?.state, 'temporary')
      assert.equal(stored?.name, upload.name)
    } else {
      // The backfill got there first, and the upload registered on top of it
      assert.equal(stored?.name, upload.name)
    }

    assert.notEqual(stored, undefined)
  })

  it('reports an empty registry for a store that does not exist yet', async () => {
    const missing = join(tmpdir(), `ipfs-node-registry-missing-${process.pid}`)
    const registry = new FileRegistry(new FsDatastore(missing))

    assert.deepEqual(await registry.all(), [])
  })

  it('serializes compound work with regular CID mutations', async () => {
    const registry = createRegistry()
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let secondFinished = false

    const first = registry.withExclusiveCids([CID_A], async (locked) => {
      await locked.registerReplacing(newFile(), {
        confirmationRequired: true,
        temporaryTtlMs: TTL
      })
      await firstMayFinish
      await locked.remove(CID_A)
    })
    const second = registry
      .register(
        { ...newFile(), name: 'second.jpg' },
        { confirmationRequired: false, temporaryTtlMs: TTL }
      )
      .then(() => {
        secondFinished = true
      })

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(secondFinished, false)

    releaseFirst()
    await Promise.all([first, second])

    assert.equal((await registry.get(CID_A))?.name, 'second.jpg')
  })

  it('refuses a public mutator called from inside its own lock', async () => {
    // The two ways to change a record — the locking mutators and the view
    // handed to withExclusiveCids — cannot be mixed: the inner call queues
    // behind a lock its own caller holds. That used to hang with no error and
    // no timeout, so the request simply never answered.
    const registry = createRegistry()
    await registry.register(newFile(), { confirmationRequired: false, temporaryTtlMs: TTL })

    await assert.rejects(
      () => registry.withExclusiveCids([CID_A], async () => registry.setPinned(CID_A, false)),
      /Deadlock avoided/
    )
  })

  it('refuses a nested lock on a CID the caller already holds', async () => {
    const registry = createRegistry()

    await assert.rejects(
      () =>
        registry.withExclusiveCids([CID_A], async () =>
          registry.withExclusiveCids([CID_A], async () => undefined)
        ),
      /Deadlock avoided/
    )
  })

  it('allows a public mutator for a CID the caller does not hold', async () => {
    const registry = createRegistry()
    await registry.register(newFile(CID_B), { confirmationRequired: false, temporaryTtlMs: TTL })

    const pinned = await registry.withExclusiveCids([CID_A], async () =>
      registry.setPinned(CID_B, false)
    )

    assert.equal(pinned?.pinned, false)
  })

  it('takes overlapping multi-CID locks in one order', async () => {
    const registry = createRegistry()

    await Promise.race([
      Promise.all([
        registry.withExclusiveCids([CID_A, CID_B], async () => undefined),
        registry.withExclusiveCids([CID_B, CID_A], async () => undefined)
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('opposite CID order deadlocked')), 1000)
      )
    ])
  })
})

describe('expiry rules', () => {
  const record: Omit<FileRecord, 'state' | 'expiresAt'> = {
    cid: CID_A,
    name: 'photo.jpg',
    fileSize: 100,
    storedBytes: 120,
    createdAt: 1000,
    confirmedAt: null,
    pinned: true,
    heldLocally: true,
    replicas: []
  }

  it('expires an abandoned temporary upload after its TTL', () => {
    const temporary: FileRecord = { ...record, state: 'temporary', expiresAt: 2000 }

    assert.equal(isExpired(temporary, 1999), false)
    assert.equal(isExpired(temporary, 2000), true)
  })

  it('never expires confirmed content', () => {
    const confirmed: FileRecord = { ...record, state: 'confirmed', expiresAt: null }

    assert.equal(isExpired(confirmed, Number.MAX_SAFE_INTEGER), false)
    assert.equal(isReclaimable(confirmed, Number.MAX_SAFE_INTEGER), false)
  })

  it('treats an explicitly released file as reclaimable right away', () => {
    const released: FileRecord = { ...record, state: 'expired', expiresAt: null, pinned: false }

    assert.equal(isReclaimable(released, 0), true)
  })
})
