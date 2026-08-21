import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { CID } from 'multiformats/cid'
import { CID_FIXTURES, README_FIXTURE, deterministicBytes } from '../fixtures.js'
import { UnixfsMulterStorage } from '../../utils/unixfs-multer.storage.js'
import type { UnixFsMulterFile } from '../../utils/types.js'

let storeDir: string
let blockstore: FsBlockstore
let ifs: UnixFS
let storage: UnixfsMulterStorage

/**
 * Push a buffer through the production multer storage engine and return the CID
 * it assigns, exactly as `POST /api/file/upload` does.
 */
async function uploadThroughStorageEngine(name: string, content: Buffer): Promise<string> {
  const file = {
    fieldname: 'files',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    stream: Readable.from(content)
  } as unknown as Express.Multer.File

  const info = await new Promise<Partial<UnixFsMulterFile>>((resolve, reject) => {
    storage._handleFile({} as never, file, (err, result) => {
      if (err != null) {
        reject(err)
        return
      }
      resolve(result as Partial<UnixFsMulterFile>)
    })
  })

  assert.ok(info.cid, `no CID returned for ${name}`)
  return info.cid.toString()
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'ipfs-node-cid-'))
  blockstore = new FsBlockstore(join(storeDir, 'blockstore'))
  await blockstore.open()
  ifs = unixfs({ blockstore })
  storage = new UnixfsMulterStorage({ unixfs: ifs })
})

after(async () => {
  await blockstore.close()
  await rm(storeDir, { recursive: true, force: true })
})

describe('file CID compatibility with the pre-migration stack', () => {
  test('reproduces the CID documented in README.md', async () => {
    const cid = await uploadThroughStorageEngine(README_FIXTURE.name, README_FIXTURE.content)
    assert.equal(cid, README_FIXTURE.cid)
  })

  for (const fixture of CID_FIXTURES) {
    test(`reproduces the pre-migration CID for ${fixture.name} (${fixture.length} bytes)`, async () => {
      const content = deterministicBytes(fixture.length, fixture.seed)
      const cid = await uploadThroughStorageEngine(fixture.name, content)

      assert.equal(cid, fixture.cid)
    })
  }

  test('stores content that reads back byte-for-byte', async () => {
    const content = deterministicBytes(3145735, 'd')
    const cid = CID.parse(await uploadThroughStorageEngine('multi-chunk.bin', content))

    const stats = await ifs.stat(cid, { offline: true })
    assert.equal(stats.size, BigInt(content.length))

    const chunks: Uint8Array[] = []
    for await (const chunk of ifs.cat(cid, { offline: true })) {
      chunks.push(chunk)
    }

    assert.deepEqual(Buffer.concat(chunks), content)
  })
})
