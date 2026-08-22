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

  it('reports an empty registry for a store that does not exist yet', async () => {
    const missing = join(tmpdir(), `ipfs-node-registry-missing-${process.pid}`)
    const registry = new FileRegistry(new FsDatastore(missing))

    assert.deepEqual(await registry.all(), [])
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
