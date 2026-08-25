import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CID } from 'multiformats/cid'
import { MAX_BLOCK_BYTES, meteredBlocks, type ReadableBlocks } from '../src/storage/meter.js'

const CID_A = CID.parse('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')

/** A blockstore that hands out fixed-size blocks in two chunks. */
function blocks(size: number): ReadableBlocks {
  return {
    get: () =>
      (async function* () {
        yield new Uint8Array(Math.ceil(size / 2))
        yield new Uint8Array(Math.floor(size / 2))
      })(),
    put: async () => CID_A,
    has: async () => true
  } as unknown as ReadableBlocks
}

async function drain(source: ReadableBlocks): Promise<void> {
  for await (const chunk of source.get(CID_A)) {
    void chunk
  }
}

describe('meteredBlocks', () => {
  it('charges every byte of a block, not what a stream would yield', async () => {
    const progress = { bytes: 0 }

    await drain(meteredBlocks(blocks(1000), progress, 10_000))

    assert.equal(progress.bytes, 1000)
  })

  it('keeps counting across blocks', async () => {
    const progress = { bytes: 0 }
    const metered = meteredBlocks(blocks(400), progress, 10_000)

    await drain(metered)
    await drain(metered)

    assert.equal(progress.bytes, 800)
  })

  it('abandons the walk once the limit is passed', async () => {
    const progress = { bytes: 0 }
    const metered = meteredBlocks(blocks(600), progress, 1000)

    await drain(metered)
    await assert.rejects(() => drain(metered), /larger than this node accepts/)
  })

  it('charges the whole block it stopped on, not the part it had read', async () => {
    const progress = { bytes: 0 }
    const metered = meteredBlocks(blocks(600), progress, 1000)

    await drain(metered)
    await assert.rejects(() => drain(metered))

    // A block is fetched and stored whole, so the overshoot is one block and
    // callers reserve MAX_BLOCK_BYTES of headroom for it
    assert.equal(progress.bytes, 1200)
    assert.ok(progress.bytes <= 1000 + MAX_BLOCK_BYTES)
  })

  it('keeps what a failed transfer already cost', async () => {
    const progress = { bytes: 0 }
    const metered = meteredBlocks(blocks(2000), progress, 1500)

    await assert.rejects(() => drain(metered))

    // A peer that sends almost everything and then aborts has spent it
    assert.ok(progress.bytes > 0, 'the bytes that arrived must still be charged')
  })
})
