import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FsDatastore } from 'datastore-fs'
import { FileRegistry } from '../src/storage/registry.js'
import { rollbackUpload } from '../src/storage/rollback.js'

const CID_A = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const TTL = 60_000
const file = { cid: CID_A, name: 'photo.jpg', fileSize: 100, storedBytes: 120 }

let storeDir: string
let datastore: FsDatastore
let counter = 0

function createRegistry(): FileRegistry {
  counter += 1
  return new FileRegistry(datastore, `/adm/rollback-${counter}`)
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'ipfs-node-rollback-'))
  datastore = new FsDatastore(join(storeDir, 'datastore'))
  await datastore.open()
})

after(async () => {
  await datastore.close()
  await rm(storeDir, { recursive: true, force: true })
})

describe('rollbackUpload', () => {
  it('removes the record and the pin this request created', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []
    const written = await registry.registerReplacing(file, {
      confirmationRequired: false,
      temporaryTtlMs: TTL
    })

    await rollbackUpload({
      registry,
      cid: CID_A,
      written: written.record,
      previous: written.previous,
      createdPin: true,
      unpin: async () => {
        unpinned.push(CID_A)
      }
    })

    // Session cleanup skips pinned blocks, so a pin left behind here would keep
    // the failed upload on disk with nothing accounting for it
    assert.equal(await registry.get(CID_A), undefined)
    assert.deepEqual(unpinned, [CID_A])
  })

  it('keeps the pin when a record survives the rollback', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []
    await registry.register(file, { confirmationRequired: false, temporaryTtlMs: TTL })

    const written = await registry.registerReplacing(file, {
      confirmationRequired: false,
      temporaryTtlMs: TTL
    })

    await rollbackUpload({
      registry,
      cid: CID_A,
      written: written.record,
      previous: written.previous,
      createdPin: true,
      unpin: async () => {
        unpinned.push(CID_A)
      }
    })

    assert.notEqual(await registry.get(CID_A), undefined)
    assert.deepEqual(unpinned, [])
  })

  it('leaves a concurrent upload of the same file alone', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []

    // This request writes first and fails later; another one adopts the CID in
    // between and is the reason both the record and the pin must stay
    const mine = await registry.registerReplacing(file, {
      confirmationRequired: false,
      temporaryTtlMs: TTL
    })
    const theirs = await registry.register(
      { ...file, name: 'theirs.jpg' },
      { confirmationRequired: false, temporaryTtlMs: TTL }
    )

    await rollbackUpload({
      registry,
      cid: CID_A,
      written: mine.record,
      previous: mine.previous,
      createdPin: true,
      unpin: async () => {
        unpinned.push(CID_A)
      }
    })

    assert.equal((await registry.get(CID_A))?.revision, theirs.revision)
    assert.deepEqual(unpinned, [])
  })

  it('does nothing when the request never wrote a record', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []

    await rollbackUpload({
      registry,
      cid: CID_A,
      written: undefined,
      previous: undefined,
      createdPin: true,
      unpin: async () => {
        unpinned.push(CID_A)
      }
    })

    assert.deepEqual(unpinned, [])
  })
})
