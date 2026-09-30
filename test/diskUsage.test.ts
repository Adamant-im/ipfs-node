import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { availableStorageSize, dirSize } from '../src/utils/utils.js'

describe('dirSize', () => {
  it('sums file sizes recursively', async () => {
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

  it('does not follow symlinks out of the tree', async () => {
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

  it('returns 0 for a missing directory', async () => {
    assert.equal(await dirSize(join(tmpdir(), 'ipfs-node-does-not-exist-12345')), 0)
  })

  it('returns 0 for an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-dirsize-empty-'))

    try {
      assert.equal(await dirSize(dir), 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('availableStorageSize', () => {
  it('reports free space for an existing directory', async () => {
    const free = await availableStorageSize(tmpdir())

    assert.equal(typeof free, 'bigint')
    assert.ok(free > 0n)
  })

  it('falls back to the nearest existing ancestor on a first run', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ipfs-node-statfs-'))

    try {
      // The store directory does not exist yet, as on a first start
      const missing = join(parent, 'store', 'blockstore')

      const [fromMissing, fromParent] = [
        await availableStorageSize(missing),
        await availableStorageSize(parent)
      ]

      // Both must measure the same filesystem. They are not compared for
      // equality: the two readings are taken a moment apart on a live volume,
      // so anything else writing to disk moves one of them.
      const drift = fromMissing > fromParent ? fromMissing - fromParent : fromParent - fromMissing

      assert.ok(fromMissing > 0n)
      assert.ok(
        drift < fromParent / 1000n,
        `readings differ by ${drift} bytes, which is more than ordinary drift`
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
