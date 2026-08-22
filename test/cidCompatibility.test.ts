import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { CID } from 'multiformats/cid'
import { CID_FIXTURES, README_FIXTURE, deterministicBytes } from './fixtures.js'
import { UnixfsMulterStorage } from '../src/utils/unixfs-multer.storage.js'
import type { UnixFsMulterFile } from '../src/utils/types.js'

let storeDir: string
let blockstore: FsBlockstore
let ifs: UnixFS
let storage: UnixfsMulterStorage

/**
 * Push a buffer through the production multer storage engine and return the
 * record it produces, exactly as `POST /api/file/upload` does.
 */
async function uploadThroughStorageEngine(
  name: string,
  content: Buffer
): Promise<Partial<UnixFsMulterFile>> {
  const file = {
    fieldname: 'files',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    stream: Readable.from(content)
  } as unknown as Express.Multer.File

  return new Promise((resolve, reject) => {
    storage._handleFile({} as never, file, (err, result) => {
      if (err != null) {
        reject(err)
        return
      }
      resolve(result as Partial<UnixFsMulterFile>)
    })
  })
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
  it('reproduces the CID documented in README.md', async () => {
    const { cid } = await uploadThroughStorageEngine(README_FIXTURE.name, README_FIXTURE.content)

    assert.equal(cid?.toString(), README_FIXTURE.cid)
  })

  for (const fixture of CID_FIXTURES) {
    it(`reproduces the pre-migration CID for ${fixture.name} (${fixture.length} bytes)`, async () => {
      const content = deterministicBytes(fixture.length, fixture.seed)
      const { cid } = await uploadThroughStorageEngine(fixture.name, content)

      assert.equal(cid?.toString(), fixture.cid)
    })
  }

  it('still sanitizes the filename, which does not affect the CID', async () => {
    const content = deterministicBytes(1024, 'small')
    const record = await uploadThroughStorageEngine('../folder\\evil\n\u202efile.txt', content)

    assert.equal(record.originalname, '_folder_evilfile.txt')
    assert.equal(record.cid?.toString(), CID_FIXTURES[1].cid)
  })

  it('stores content that reads back byte-for-byte', async () => {
    const content = deterministicBytes(3145735, 'd')
    const { cid } = await uploadThroughStorageEngine('multi-chunk.bin', content)
    const parsed = CID.parse(String(cid))

    const stats = await ifs.stat(parsed, { offline: true })
    assert.equal(stats.size, BigInt(content.length))

    const chunks: Uint8Array[] = []
    for await (const chunk of ifs.cat(parsed, { offline: true })) {
      chunks.push(chunk)
    }

    assert.deepEqual(Buffer.concat(chunks), content)
  })
})
