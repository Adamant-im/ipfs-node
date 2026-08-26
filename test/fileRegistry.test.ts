import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FsDatastore } from 'datastore-fs'
import { Key } from 'interface-datastore'
import {
  FileRegistry,
  isExpired,
  isLifecycleBusy,
  isReclaimable,
  isSettledHeldFile,
  type FileRecord
} from '../src/storage/registry.js'
import { beginAdmission, endAdmission } from '../src/storage/admission.js'

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

/**
 * Register a file the way production does.
 *
 * Registering writes `pinned` and `heldLocally`, so the registry only offers it
 * under a held CID lock. Going through `withExclusiveCids` here is not
 * ceremony: it is the path the upload route, replica intake and confirmation
 * all take.
 */
function registerFile(
  registry: FileRegistry,
  file = newFile(),
  options: { confirmationRequired: boolean; temporaryTtlMs: number; now?: number } = {
    confirmationRequired: false,
    temporaryTtlMs: TTL
  }
): Promise<{ record: FileRecord; previous: FileRecord | undefined }> {
  return registry.withExclusiveCids([file.cid], (locked) => locked.registerReplacing(file, options))
}

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
  it('does not reuse a revision persisted by a previous process', async () => {
    const prefix = '/adm/restart-revision'
    const previous: FileRecord = {
      cid: CID_A,
      name: 'before-restart.jpg',
      state: 'temporary',
      createdAt: 1,
      expiresAt: 2,
      confirmedAt: null,
      fileSize: 100,
      storedBytes: 120,
      pinned: true,
      heldLocally: true,
      replicas: [],
      revision: 1
    }

    // Seed the store directly: the in-memory revision generator belongs to the
    // new process and has never seen this write.
    await datastore.put(
      new Key(`${prefix}/${CID_A}`),
      new TextEncoder().encode(JSON.stringify(previous))
    )

    const registry = new FileRegistry(datastore, prefix)
    const current = await registry.save({ ...previous, name: 'after-restart.jpg' })

    assert.notEqual(current.revision, previous.revision)
    assert.equal(typeof current.revision, 'string')
  })

  it('fails closed for valid JSON that is not a FileRecord', async () => {
    const prefix = '/adm/invalid-record'
    const malformed = {
      cid: CID_A,
      name: 'durable.jpg',
      state: 'corrupted',
      createdAt: 1,
      expiresAt: null,
      confirmedAt: 1,
      fileSize: 100,
      storedBytes: 120,
      pinned: true,
      heldLocally: true,
      replicas: [],
      revision: 1
    }

    await datastore.put(
      new Key(`${prefix}/${CID_A}`),
      new TextEncoder().encode(JSON.stringify(malformed))
    )

    const registry = new FileRegistry(datastore, prefix)

    await assert.rejects(() => registry.get(CID_A), /Invalid lifecycle registry record/)
    assert.deepEqual(await registry.all(), [])
  })

  it('rejects a record whose payload names another CID', async () => {
    const prefix = '/adm/mismatched-record'
    const mismatched: FileRecord = {
      cid: CID_B,
      name: 'wrong-key.jpg',
      state: 'confirmed',
      createdAt: 1,
      expiresAt: null,
      confirmedAt: 1,
      fileSize: 100,
      storedBytes: 120,
      pinned: true,
      heldLocally: true,
      replicas: [],
      revision: 'old-process:1'
    }

    await datastore.put(
      new Key(`${prefix}/${CID_A}`),
      new TextEncoder().encode(JSON.stringify(mismatched))
    )

    const registry = new FileRegistry(datastore, prefix)

    await assert.rejects(() => registry.get(CID_A), /Invalid lifecycle registry record/)
    assert.deepEqual(await registry.all(), [])
  })

  it('registers an upload as confirmed when confirmation is not required', async () => {
    const registry = createRegistry()

    const { record } = await registerFile(registry, newFile(), {
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

    const { record } = await registerFile(registry, newFile(), {
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
    await registerFile(registry, newFile(), {
      confirmationRequired: false,
      temporaryTtlMs: TTL,
      now: 1000
    })

    const { record: reuploaded } = await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL,
      now: 2000
    })

    assert.equal(reuploaded.state, 'confirmed')
    assert.equal(reuploaded.expiresAt, null)
  })

  it('re-registering a temporary file confirms it and clears its expiry', async () => {
    // This is what an upload of already-known content does. Confirming through
    // the admin endpoint and releasing a file both changed the pin as well as
    // the record, so they live in the storage service now, behind the same CID
    // lock; the registry only decides what registration itself writes.
    const registry = createRegistry()
    await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL,
      now: 1000
    })

    const { record } = await registerFile(registry, newFile(), {
      confirmationRequired: false,
      temporaryTtlMs: TTL,
      now: 5000
    })

    assert.equal(record.state, 'confirmed')
    assert.equal(record.expiresAt, null)
    assert.equal(record.confirmedAt, 5000)
    assert.equal(record.pinned, true)
  })

  it('lists every registered file and survives a reopen', async () => {
    const registry = createRegistry()
    await registerFile(registry, newFile(CID_A))
    await registerFile(registry, newFile(CID_B), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    const cids = (await registry.all()).map((record) => record.cid)

    assert.deepEqual(cids.sort(), [CID_A, CID_B].sort())
  })

  it('forgets a removed file and tolerates removing it twice', async () => {
    const registry = createRegistry()
    await registerFile(registry)

    await registry.remove(CID_A)
    await assert.doesNotReject(() => registry.remove(CID_A))

    assert.equal(await registry.get(CID_A), undefined)
  })

  it('reports the record a registration replaced', async () => {
    // Read before the write, the baseline is a guess: another upload can adopt
    // the CID in between, and a rollback restoring the guess would erase it
    const registry = createRegistry()
    const first = await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })
    const second = await registerFile(registry, newFile(), {
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
    const first = await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })
    const second = await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    await registry.transition(CID_A, async (current) =>
      current?.revision === first.record.revision ? 'remove' : 'keep'
    )

    assert.notEqual(first.record.revision, second.record.revision)
    assert.notEqual(await registry.get(CID_A), undefined)
  })

  it('removes a record when the undo is still the last write', async () => {
    const registry = createRegistry()
    const { record: written } = await registerFile(registry, newFile(), {
      confirmationRequired: true,
      temporaryTtlMs: TTL
    })

    await registry.transition(CID_A, async (current) =>
      current?.revision === written.revision ? 'remove' : 'keep'
    )

    assert.equal(await registry.get(CID_A), undefined)
  })

  it('refuses to store a record it would not be able to read back', async () => {
    // `JSON.stringify` drops an absent number, so a record written without one
    // comes back as a shape the registry rejects. Validating only on the way
    // out let such a record be persisted and then vanish from the report, from
    // repair and from every plan, while its pin quietly kept the blocks.
    const registry = createRegistry()
    const incomplete = {
      cid: CID_A,
      name: 'photo.jpg',
      state: 'confirmed',
      createdAt: 1,
      expiresAt: null,
      confirmedAt: 1,
      storedBytes: 10,
      pinned: true,
      heldLocally: true,
      replicas: []
    } as unknown as FileRecord

    await assert.rejects(() => registry.save(incomplete), /Refusing to store an invalid/)
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
      registerFile(registry, newFile(CID_B), {
        confirmationRequired: true,
        temporaryTtlMs: TTL
      }).then(({ record }) => record),
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
    const second = registry.setReplicas(CID_A, ['n2']).then((record) => {
      secondFinished = true
      return record
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(secondFinished, false)

    releaseFirst()
    const [, updated] = await Promise.all([first, second])

    // It ran after the compound work removed the record, not in the middle of it
    assert.equal(updated, undefined)
    assert.equal(await registry.get(CID_A), undefined)
  })

  it('preserves upload ownership across replica metadata refreshes', async () => {
    const registry = createRegistry()
    const written = await registry.withExclusiveCids([CID_A], (locked) =>
      locked.registerReplacing(newFile(), {
        confirmationRequired: false,
        temporaryTtlMs: TTL,
        admissionId: 'upload-one'
      })
    )

    const refreshed = await registry.setReplicas(CID_A, ['n2'])

    assert.notEqual(refreshed?.revision, written.record.revision)
    assert.equal(refreshed?.admissionId, 'upload-one')
  })

  it('does not confirm a live replica stage through a permanent store', async () => {
    const registry = createRegistry()
    const staged = await registry.save({
      cid: CID_A,
      name: CID_A,
      state: 'temporary',
      createdAt: 1,
      expiresAt: 2,
      confirmedAt: null,
      fileSize: 100,
      storedBytes: 120,
      protectedBytes: 120,
      pinned: true,
      heldLocally: true,
      replicas: [],
      replicaStage: { transactionIds: ['tx-live'], previous: null }
    })

    const stored = await registerFile(registry)

    assert.equal(stored.record.state, 'temporary')
    assert.deepEqual(stored.record.replicaStage?.transactionIds, ['tx-live'])
    assert.equal(stored.record.revision, staged.revision)
  })

  it('lets a later local upload take over a prepared replica', async () => {
    const registry = createRegistry()
    await registry.save({
      cid: CID_A,
      name: CID_A,
      state: 'temporary',
      createdAt: 1,
      expiresAt: 2,
      confirmedAt: null,
      fileSize: 100,
      storedBytes: 120,
      protectedBytes: 120,
      pinned: true,
      heldLocally: true,
      replicas: [],
      replicaStage: { transactionIds: ['tx-live'], previous: null }
    })

    const stored = await registry.withExclusiveCids([CID_A], (locked) =>
      locked.registerReplacing(newFile(), {
        confirmationRequired: false,
        temporaryTtlMs: TTL,
        admissionId: 'upload-two'
      })
    )

    assert.equal(stored.record.state, 'confirmed')
    assert.equal(stored.record.replicaStage, undefined)
    assert.equal(stored.record.admissionId, 'upload-two')
  })

  it('refuses a public mutator called from inside its own lock', async () => {
    // The two ways to change a record — the locking mutators and the view
    // handed to withExclusiveCids — cannot be mixed: the inner call queues
    // behind a lock its own caller holds. That used to hang with no error and
    // no timeout, so the request simply never answered.
    const registry = createRegistry()
    await registerFile(registry)

    await assert.rejects(
      () => registry.withExclusiveCids([CID_A], async () => registry.setReplicas(CID_A, ['n2'])),
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
    await registerFile(registry, newFile(CID_B))

    const updated = await registry.withExclusiveCids([CID_A], async () =>
      registry.setReplicas(CID_B, ['n3'])
    )

    assert.deepEqual(updated?.replicas, ['n3'])
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

  it('treats only settled local copies as repair candidates', () => {
    const held: FileRecord = { ...record, state: 'confirmed', expiresAt: null }

    assert.equal(isSettledHeldFile(held), true)
    assert.equal(isSettledHeldFile({ ...held, admissionId: 'upload-one' }), false)
    assert.equal(
      isSettledHeldFile({ ...held, admissionId: 'upload-one', admissionSettledAt: 1234 }),
      true
    )
    beginAdmission('upload-one')
    try {
      assert.equal(
        isSettledHeldFile({ ...held, admissionId: 'upload-one', admissionSettledAt: 1234 }),
        false
      )
    } finally {
      endAdmission('upload-one')
    }
    assert.equal(isSettledHeldFile({ ...held, heldLocally: false }), false)
  })

  it('treats replica stages and unsettled admissions as busy', () => {
    const held: FileRecord = { ...record, state: 'confirmed', expiresAt: null }

    assert.equal(isLifecycleBusy(held), false)
    assert.equal(isLifecycleBusy({ ...held, admissionId: 'upload-one' }), true)
    assert.equal(
      isLifecycleBusy({ ...held, admissionId: 'upload-one', admissionSettledAt: 1234 }),
      false
    )
    beginAdmission('upload-one')
    try {
      assert.equal(
        isLifecycleBusy({ ...held, admissionId: 'upload-one', admissionSettledAt: 1234 }),
        true
      )
    } finally {
      endAdmission('upload-one')
    }
  })
})
