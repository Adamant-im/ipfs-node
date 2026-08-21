import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { dirSize, flatFiles, peerIdFromMultiaddr } from '../../utils/utils.js'
import type { UnixFsMulterFile } from '../../utils/types.js'

const PEER_ID = '12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq'

describe('peerIdFromMultiaddr', () => {
  test('extracts the peer id from a plain multiaddr', () => {
    const peerId = peerIdFromMultiaddr(`/ip4/194.163.154.252/tcp/4001/p2p/${PEER_ID}`)

    assert.equal(peerId.toString(), PEER_ID)
  })

  test('extracts the peer id from a p2p-circuit multiaddr', () => {
    const peerId = peerIdFromMultiaddr(`/ip4/38.143.66.227/tcp/4001/p2p/${PEER_ID}/p2p-circuit`)

    assert.equal(peerId.toString(), PEER_ID)
  })

  test('throws when the multiaddr carries no peer id', () => {
    assert.throws(() => peerIdFromMultiaddr('/ip4/127.0.0.1/tcp/4001'), /Invalid multiAddr/)
  })
})

describe('flatFiles', () => {
  const file = (originalname: string) => ({ originalname }) as UnixFsMulterFile

  test('passes an array through unchanged', () => {
    const files = [file('a.txt'), file('b.txt')]

    assert.deepEqual(flatFiles(files), files)
  })

  test('flattens the fieldname map produced by .fields()', () => {
    const flattened = flatFiles({ files: [file('a.txt')], extra: [file('b.txt')] })

    assert.deepEqual(
      flattened.map((item) => item.originalname),
      ['a.txt', 'b.txt']
    )
  })

  test('returns an empty array for an empty map', () => {
    assert.deepEqual(flatFiles({}), [])
  })
})

describe('dirSize', () => {
  test('sums file sizes recursively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-dirsize-'))

    try {
      await writeFile(join(dir, 'a.bin'), Buffer.alloc(100))
      await mkdir(join(dir, 'nested', 'deeper'), { recursive: true })
      await writeFile(join(dir, 'nested', 'b.bin'), Buffer.alloc(250))
      await writeFile(join(dir, 'nested', 'deeper', 'c.bin'), Buffer.alloc(1))

      assert.equal(await dirSize(dir), 351)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not follow symlinks out of the tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-dirsize-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'ipfs-node-dirsize-outside-'))

    try {
      await writeFile(join(outside, 'big.bin'), Buffer.alloc(10_000))
      await writeFile(join(dir, 'a.bin'), Buffer.alloc(100))
      await symlink(join(outside, 'big.bin'), join(dir, 'link.bin'))

      // The link itself is counted, its 10 kB target is not
      const size = await dirSize(dir)
      assert.ok(size >= 100 && size < 1000, `unexpected size ${size}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('returns 0 for a missing directory', async () => {
    assert.equal(await dirSize(join(tmpdir(), 'ipfs-node-does-not-exist-12345')), 0)
  })

  test('returns 0 for an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-dirsize-empty-'))

    try {
      assert.equal(await dirSize(dir), 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
