import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CID } from 'multiformats/cid'
import { UploadSession } from '../src/storage/uploadSession.js'

const CID_A = CID.parse('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')

function memoryStore(): {
  blockstore: {
    has: (cid: CID) => Promise<boolean>
    put: (cid: CID, block: Uint8Array) => Promise<CID>
    get: (cid: CID) => AsyncGenerator<Uint8Array>
  }
  deleted: string[]
} {
  const blocks = new Map<string, Uint8Array>()
  const deleted: string[] = []

  return {
    deleted,
    blockstore: {
      async has(cid) {
        return blocks.has(cid.toString())
      },
      async put(cid, block) {
        blocks.set(cid.toString(), block)
        return cid
      },
      async *get(cid) {
        const block = blocks.get(cid.toString())
        if (block !== undefined) {
          yield block
        }
      }
    }
  }
}

describe('UploadSession claim', () => {
  it('lets the handler clean up a claimed session, but not a disconnect', async () => {
    const { blockstore } = memoryStore()
    const session = new UploadSession({
      blockstore: blockstore as never,
      isPinned: async () => false,
      deleteBlock: async () => undefined,
      maxRequestSizeBytes: 1024,
      parseCid: (value) => CID.parse(value)
    })

    assert.equal(session.claim(), true)
    assert.equal(await session.cleanupIfUnclaimed(), 0)
    assert.equal(session.isSettled, false)
    assert.equal(await session.cleanup(), 0)
    assert.equal(session.isSettled, true)
    assert.equal(session.claim(), false)
  })
})

describe('UploadSession cleanup', () => {
  it('does not delete a block another upload retained after the snapshot', async () => {
    const { blockstore, deleted } = memoryStore()
    let releasePinned: () => void = () => undefined
    const pinnedGate = new Promise<void>((resolve) => {
      releasePinned = resolve
    })

    const sessionA = new UploadSession({
      blockstore: blockstore as never,
      isPinned: async () => {
        await pinnedGate
        return false
      },
      deleteBlock: async (cid) => {
        deleted.push(cid.toString())
      },
      maxRequestSizeBytes: 1024,
      parseCid: (value) => CID.parse(value)
    })
    const sessionB = new UploadSession({
      blockstore: blockstore as never,
      isPinned: async () => false,
      deleteBlock: async () => undefined,
      maxRequestSizeBytes: 1024,
      parseCid: (value) => CID.parse(value)
    })

    await sessionA.blockstore.put(CID_A, new Uint8Array([1, 2, 3]))
    const cleanup = sessionA.cleanup()
    await sessionB.blockstore.put(CID_A, new Uint8Array([1, 2, 3]))
    releasePinned()

    assert.equal(await cleanup, 0)
    assert.deepEqual(deleted, [])
  })
})
