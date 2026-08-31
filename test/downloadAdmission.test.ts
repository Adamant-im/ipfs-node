import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { createDownloadAdmission } from '../src/middleware/downloadAdmission.js'
import { ConcurrencyLimiter } from '../src/storage/limits.js'

describe('download concurrency admission', () => {
  let url = ''
  let close: (() => Promise<void>) | undefined
  let finishFirst!: () => void

  before(async () => {
    const limiter = new ConcurrencyLimiter(1)
    const app = express()
    let requests = 0
    app.get('/file', createDownloadAdmission(limiter), (_req, res) => {
      requests += 1
      if (requests === 1) {
        finishFirst = () => res.send('first')
        return
      }
      res.send('next')
    })
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    const address = server.address() as AddressInfo
    url = `http://127.0.0.1:${address.port}`
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  })

  after(async () => close?.())

  it('returns 429 while the global slot is occupied and releases it on completion', async () => {
    const first = fetch(`${url}/file`)
    while (finishFirst === undefined) await new Promise((resolve) => setImmediate(resolve))

    const rejected = await fetch(`${url}/file`)
    assert.equal(rejected.status, 429)
    assert.equal(rejected.headers.get('retry-after'), '5')

    finishFirst()
    assert.equal((await first).status, 200)
    assert.equal((await fetch(`${url}/file`)).status, 200)
  })
})
