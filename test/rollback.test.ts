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
    await registry.withExclusiveCids([CID_A], async (locked) => {
      const written = await locked.registerReplacing(file, {
        confirmationRequired: false,
        temporaryTtlMs: TTL
      })

      await rollbackUpload({
        registry: locked,
        cid: CID_A,
        previous: written.previous,
        createdPin: true,
        unpin: async () => {
          unpinned.push(CID_A)
        }
      })
    })

    // Session cleanup skips pinned blocks, so a pin left behind here would keep
    // the failed upload on disk with nothing accounting for it
    assert.equal(await registry.get(CID_A), undefined)
    assert.deepEqual(unpinned, [CID_A])
  })

  it('keeps the pin when a record survives the rollback', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []
    await registry.withExclusiveCids([CID_A], (locked) =>
      locked.registerReplacing(file, { confirmationRequired: false, temporaryTtlMs: TTL })
    )

    await registry.withExclusiveCids([CID_A], async (locked) => {
      const written = await locked.registerReplacing(file, {
        confirmationRequired: false,
        temporaryTtlMs: TTL
      })

      await rollbackUpload({
        registry: locked,
        cid: CID_A,
        previous: written.previous,
        createdPin: true,
        unpin: async () => {
          unpinned.push(CID_A)
        }
      })
    })

    assert.notEqual(await registry.get(CID_A), undefined)
    assert.deepEqual(unpinned, [])
  })

  it('restores an unpinned previous record and its real pin state', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []
    // What the storage service leaves behind when a file is released: the
    // record survives, unpinned and reclaimable
    await registry.withExclusiveCids([CID_A], async (locked) => {
      const { record } = await locked.registerReplacing(file, {
        confirmationRequired: false,
        temporaryTtlMs: TTL
      })
      await locked.save({ ...record, state: 'expired', pinned: false, heldLocally: false })
    })

    await registry.withExclusiveCids([CID_A], async (locked) => {
      const written = await locked.registerReplacing(file, {
        confirmationRequired: false,
        temporaryTtlMs: TTL
      })

      await rollbackUpload({
        registry: locked,
        cid: CID_A,
        previous: written.previous,
        createdPin: true,
        unpin: async () => {
          unpinned.push(CID_A)
        }
      })
    })

    assert.equal((await registry.get(CID_A))?.state, 'expired')
    assert.equal((await registry.get(CID_A))?.pinned, false)
    assert.deepEqual(unpinned, [CID_A])
  })

  it('removes a created pin when registration never wrote a record', async () => {
    const registry = createRegistry()
    const unpinned: string[] = []

    await registry.withExclusiveCids([CID_A], async (locked) => {
      await rollbackUpload({
        registry: locked,
        cid: CID_A,
        previous: undefined,
        createdPin: true,
        unpin: async () => {
          unpinned.push(CID_A)
        }
      })
    })

    assert.equal(await registry.get(CID_A), undefined)
    assert.deepEqual(unpinned, [CID_A])
  })

  it('serializes two failed uploads so neither lifecycle survives', async () => {
    const registry = createRegistry()
    let pinned = false

    const failUpload = (name: string): Promise<void> =>
      registry.withExclusiveCids([CID_A], async (locked) => {
        const previous = await locked.get(CID_A)
        const createdPin = !pinned
        pinned = true
        await locked.registerReplacing(
          { ...file, name },
          { confirmationRequired: false, temporaryTtlMs: TTL }
        )

        await rollbackUpload({
          registry: locked,
          cid: CID_A,
          previous,
          createdPin,
          unpin: async () => {
            pinned = false
          }
        })
      })

    await Promise.all([failUpload('first.jpg'), failUpload('second.jpg')])

    assert.equal(await registry.get(CID_A), undefined)
    assert.equal(pinned, false)
  })
})
