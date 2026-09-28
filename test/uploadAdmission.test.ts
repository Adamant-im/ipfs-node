import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import express, { type Express } from 'express'
import type { Blockstore } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'
import {
  createUploadAdmission,
  type UploadAdmissionDependencies
} from '../src/middleware/uploadAdmission.js'
import { resetClaims } from '../src/storage/reservation.js'

describe('upload admission diagnostics', () => {
  it('names a concurrency refusal separately from the rate limiter', async () => {
    const app = express()
    app.post('/upload', createUploadAdmission(dependencies(() => false)), (req, res) =>
      res.send({ ok: true })
    )
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/upload`, { method: 'POST' })

      assert.equal(response.status, 429)
      assert.equal(response.headers.get('retry-after'), '5')
      assert.deepEqual(await response.json(), {
        error: 'Too many concurrent uploads. Please try again later.',
        code: 'upload_concurrency'
      })
    } finally {
      await server.close()
    }
  })

  it('names a request that declares more than the aggregate limit', async () => {
    const app = express()
    app.post('/upload', createUploadAdmission(dependencies(() => true)), (req, res) =>
      res.send({ ok: true })
    )
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'x'.repeat(2048)
      })

      assert.equal(response.status, 413)
      assert.deepEqual(await response.json(), {
        error: 'Upload size limit exceeded',
        code: 'request_too_large'
      })
    } finally {
      await server.close()
    }
  })

  it('names a request that would consume the disk reserve', async () => {
    resetClaims()
    const app = express()
    app.post('/upload', createUploadAdmission(dependencies(() => true)), (req, res) =>
      res.send({ ok: true })
    )
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'x'.repeat(32)
      })

      assert.equal(response.status, 507)
      assert.deepEqual(await response.json(), {
        error: 'Insufficient storage',
        code: 'insufficient_storage'
      })
    } finally {
      resetClaims()
      await server.close()
    }
  })
})

function dependencies(tryAcquire: () => boolean): UploadAdmissionDependencies {
  return {
    storage: { maxRequestSizeBytes: 1024, diskReserveBytes: 10_000 },
    limiter: { tryAcquire, release() {} },
    operationLock: { acquireShared: async () => ({ release() {} }) },
    availableStorageSize: async () => 100n,
    blockstore: {} as Blockstore,
    isPinned: async () => false,
    deleteBlock: async () => undefined,
    parseCid: (cid: string) => cid as unknown as CID,
    log: { info() {}, warn() {}, error() {} }
  }
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<Express['listen']>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
