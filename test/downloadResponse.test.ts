import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import express, { type Express } from 'express'
import { getPublicError } from '../src/security/errors.js'
import { matchesDownloadEtag, sendDownloadStream } from '../src/utils/downloadResponse.js'
import { FileNotFoundError } from '../src/utils/fileErrors.js'

describe('download response streaming', () => {
  it('matches strong, weak, list, and wildcard validators for the CID ETag', () => {
    assert.equal(matchesDownloadEtag('"bafytest"', 'bafytest'), true)
    assert.equal(matchesDownloadEtag('W/"bafytest"', 'bafytest'), true)
    assert.equal(matchesDownloadEtag('"other", "bafytest"', 'bafytest'), true)
    assert.equal(matchesDownloadEtag('*', 'bafytest'), true)
    assert.equal(matchesDownloadEtag('"other"', 'bafytest'), false)
  })

  it('keeps an early stream error as a controlled JSON response', async () => {
    const app = express()
    app.get('/file', (req, res, next) => {
      void req
      const stream = new Readable({
        read() {
          this.destroy(new FileNotFoundError('/private/blockstore/path'))
        }
      })

      sendDownloadStream(stream, res, { cid: 'bafytest', fileSize: 1n }, next, () => undefined)
    })
    app.use(
      (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
        void req
        void _next
        const publicError = getPublicError(err)
        res.status(publicError.status).send(publicError.body)
      }
    )
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/file`)

      assert.equal(response.status, 408)
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
      assert.equal(response.headers.get('content-disposition'), null)
      assert.deepEqual(await response.json(), { error: 'File request timed out' })
    } finally {
      await server.close()
    }
  })

  it('terminates an incomplete binary response after streaming starts', async () => {
    const app = express()
    let lateErrors = 0
    app.get('/file', (req, res, next) => {
      void req
      let emitted = false
      const stream = new Readable({
        read() {
          if (emitted) {
            return
          }
          emitted = true
          this.push(Buffer.from('a'))
          queueMicrotask(() => this.destroy(new Error('late failure')))
        }
      })

      sendDownloadStream(stream, res, { cid: 'bafytest', fileSize: 2n }, next, () => {
        lateErrors += 1
      })
    })
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/file`)

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="bafytest"')
      assert.equal(response.headers.get('etag'), '"bafytest"')
      assert.equal(response.headers.get('accept-ranges'), 'none')
      assert.equal(response.headers.get('cache-control'), 'private, max-age=3600, must-revalidate')
      await assert.rejects(response.arrayBuffer())
      assert.equal(lateErrors, 1)
    } finally {
      await server.close()
    }
  })
})

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
