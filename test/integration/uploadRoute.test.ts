import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { type UnixFS, unixfs } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import express from 'express'
import multer from 'multer'
import { CID } from 'multiformats/cid'
import { createUploadHandler } from '../../src/api/uploadRoute.js'
import { createIpfsNode, type IpfsNode } from '../../src/ipfs-node.js'
import { createUploadAdmission, getUploadSession } from '../../src/middleware/uploadAdmission.js'
import { ConcurrencyLimiter } from '../../src/storage/limits.js'
import { StorageOperationLock } from '../../src/storage/operationLock.js'
import { isDirectlyPinned } from '../../src/storage/pinning.js'
import { FileRegistry } from '../../src/storage/registry.js'
import type { ReplicationReport } from '../../src/storage/replication.js'
import { resetClaims } from '../../src/storage/reservation.js'
import { UnixfsMulterStorage } from '../../src/utils/unixfs-multer.storage.js'
import { deterministicBytes } from '../fixtures.js'

const LISTEN = ['/ip4/127.0.0.1/tcp/0']
const MiB = 1024 * 1024

let storeDir: string
let blockstore: FsBlockstore
let datastore: FsDatastore
let node: IpfsNode
let ifs: UnixFS
let prefix = 0

/** A best-effort report, which is what a node with replication off produces. */
const bestEffort = (): ReplicationReport => ({
  mode: 'best-effort',
  desiredCopies: 1,
  copies: 1,
  required: 1,
  acknowledged: 1,
  replicas: [],
  cached: [],
  satisfied: true,
  networkTooSmall: true,
  attempts: []
})

interface Harness {
  server: Server
  url: string
  registry: FileRegistry
  lock: StorageOperationLock
  replicated: string[]
}

/**
 * The upload endpoint as it is actually assembled: admission, the multipart
 * parser that imports straight into the blockstore, and the route handler.
 *
 * Only the network-facing side is stubbed. Everything that touches storage is
 * the production code, because the point of this file is the path a request
 * really takes.
 */
async function serveUpload(
  overrides: {
    replicate?: (cid: string) => Promise<ReplicationReport>
    requireQuorumOnUpload?: boolean
  } = {}
): Promise<Harness> {
  prefix += 1
  const registry = new FileRegistry(datastore, `/adm/route-${prefix}`)
  const lock = new StorageOperationLock()
  const replicated: string[] = []

  const admit = createUploadAdmission({
    storage: { maxRequestSizeBytes: 64 * MiB, diskReserveBytes: 0 },
    limiter: new ConcurrencyLimiter(4),
    operationLock: lock,
    availableStorageSize: async () => BigInt(1024 * MiB),
    blockstore: node.blockstore,
    isPinned: (cid) => node.pins.isPinned(cid),
    deleteBlock: (cid) => blockstore.delete(cid),
    parseCid: (value) => CID.parse(value),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }
  })

  const app = express()
  app.post(
    '/upload',
    admit,
    multer({ storage: new UnixfsMulterStorage({ getSession: getUploadSession }) }).array('files'),
    createUploadHandler({
      node,
      registry,
      getSession: getUploadSession,
      confirmationRequired: false,
      temporaryTtlMs: 60_000,
      requireQuorumOnUpload: overrides.requireQuorumOnUpload ?? false,
      replicate:
        overrides.replicate ??
        (async (cid) => {
          replicated.push(cid)
          return bestEffort()
        }),
      log: { info: () => undefined, error: () => undefined }
    })
  )

  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return { server, url: `http://127.0.0.1:${port}/upload`, registry, lock, replicated }
}

async function post(
  url: string,
  parts: Array<{ name: string; bytes: Uint8Array }>
): Promise<Response> {
  const form = new FormData()
  for (const part of parts) {
    form.append('files', new Blob([part.bytes as BlobPart]), part.name)
  }

  return fetch(url, { method: 'POST', body: form })
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'ipfs-node-upload-route-'))
  blockstore = new FsBlockstore(join(storeDir, 'blockstore'))
  datastore = new FsDatastore(join(storeDir, 'datastore'))
  await blockstore.open()
  await datastore.open()
  node = await createIpfsNode({ blockstore, datastore, listen: LISTEN, bootstrap: [], allow: [] })
  ifs = unixfs(node)
})

after(async () => {
  await node.stop()
  await blockstore.close()
  await datastore.close()
  await rm(storeDir, { recursive: true, force: true })
  resetClaims()
})

describe('the upload endpoint end to end', () => {
  it('stores a file, records it whole, and pins it', async () => {
    // Every earlier test built its records by hand, which is why a route that
    // wrote records without a file size went unnoticed until a node refused to
    // read its own registry.
    const harness = await serveUpload()
    const payload = deterministicBytes(140_000, 'route-single')

    try {
      const response = await post(harness.url, [{ name: 'photo.jpg', bytes: payload }])
      const body = (await response.json()) as { cids: string[] }

      assert.equal(response.status, 200)
      assert.equal(body.cids.length, 1)

      const record = await harness.registry.get(body.cids[0])

      assert.equal(record?.state, 'confirmed')
      assert.equal(record?.name, 'photo.jpg')
      assert.equal(record?.fileSize, payload.byteLength)
      assert.ok((record?.storedBytes ?? 0) > 0)
      assert.ok((record?.protectedBytes ?? 0) >= (record?.storedBytes ?? 0))
      assert.equal(await isDirectlyPinned(node, CID.parse(body.cids[0])), true)
      assert.deepEqual(harness.replicated, [body.cids[0]])
    } finally {
      harness.server.close()
    }
  })

  it('records every file of a multi-part request', async () => {
    const harness = await serveUpload()

    try {
      const response = await post(harness.url, [
        { name: 'one.bin', bytes: deterministicBytes(90_000, 'route-one') },
        { name: 'two.bin', bytes: deterministicBytes(70_000, 'route-two') }
      ])
      const body = (await response.json()) as { cids: string[] }

      assert.equal(response.status, 200)
      assert.equal(new Set(body.cids).size, 2)

      for (const cid of body.cids) {
        const record = await harness.registry.get(cid)
        assert.equal(record?.state, 'confirmed')
        assert.ok((record?.fileSize ?? 0) > 0, `${cid} was recorded without a file size`)
      }
    } finally {
      harness.server.close()
    }
  })

  it('gives the storage lease back once the request is done', async () => {
    // Deletion waits behind this lease. A request that never returned it would
    // stop the collector from ever running again.
    const harness = await serveUpload()

    try {
      await post(harness.url, [
        { name: 'lease.bin', bytes: deterministicBytes(50_000, 'route-lease') }
      ])

      const exclusive = await Promise.race([
        harness.lock.acquireExclusive().then(() => 'granted'),
        new Promise((resolve) => setTimeout(() => resolve('still held'), 1000))
      ])

      assert.equal(exclusive, 'granted')
    } finally {
      harness.server.close()
    }
  })

  it('leaves nothing behind when the request fails after importing', async () => {
    const harness = await serveUpload({
      replicate: async () => {
        throw new Error('replication exploded')
      }
    })
    const payload = deterministicBytes(60_000, 'route-fails')
    const cid = (await ifs.addBytes(payload)).toString()

    try {
      const response = await post(harness.url, [{ name: 'doomed.bin', bytes: payload }])

      assert.equal(response.status, 500)

      // A replication failure rejects the transaction before the request gives
      // its blocks to the registry.
      const record = await harness.registry.get(cid)
      assert.equal(record, undefined)
      assert.equal(await isDirectlyPinned(node, CID.parse(cid)), false)
    } finally {
      harness.server.close()
    }
  })

  it('restores a pre-existing durable file when a re-upload misses strict quorum', async () => {
    let satisfied = true
    const harness = await serveUpload({
      requireQuorumOnUpload: true,
      replicate: async () => ({
        mode: 'quorum',
        desiredCopies: 2,
        copies: 2,
        required: 2,
        acknowledged: satisfied ? 2 : 1,
        replicas: satisfied ? ['peer'] : [],
        cached: [],
        satisfied,
        networkTooSmall: false,
        attempts: []
      })
    })
    const payload = deterministicBytes(75_000, 'strict-reupload')

    try {
      const first = await post(harness.url, [{ name: 'original.bin', bytes: payload }])
      const firstBody = (await first.json()) as { cids: string[] }
      const cid = firstBody.cids[0]
      const before = await harness.registry.get(cid)

      assert.equal(first.status, 200)
      assert.equal(before?.state, 'confirmed')
      assert.deepEqual(before?.replicas, ['peer'])

      satisfied = false
      const second = await post(harness.url, [{ name: 'replacement.bin', bytes: payload }])
      const after = await harness.registry.get(cid)

      assert.equal(second.status, 503)
      assert.equal(after?.state, 'confirmed')
      assert.equal(after?.name, 'original.bin')
      assert.deepEqual(after?.replicas, ['peer'])
      assert.equal(after?.pinned, true)
      assert.equal(await isDirectlyPinned(node, CID.parse(cid)), true)
    } finally {
      harness.server.close()
    }
  })
})
