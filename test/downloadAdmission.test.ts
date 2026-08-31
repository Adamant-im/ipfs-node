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

describe('per-client download share', () => {
  let url = ''
  let close: (() => Promise<void>) | undefined
  let release!: () => void
  let client = 'first'

  before(async () => {
    // Room to spare globally, so only the per-client share can refuse a request.
    const limiter = new ConcurrencyLimiter(8)
    const app = express()
    let held = 0
    app.get(
      '/file',
      createDownloadAdmission(limiter, { perClientLimit: 1, clientKey: () => client }),
      (_req, res) => {
        held += 1
        if (held === 1) {
          release = () => res.send('held')
          return
        }
        res.send('next')
      }
    )
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

  it('refuses one address beyond its share while others still get slots', async () => {
    const held = fetch(`${url}/file`)
    while (release === undefined) await new Promise((resolve) => setImmediate(resolve))

    assert.equal((await fetch(`${url}/file`)).status, 429)

    // A different address is unaffected: the global limiter still has room.
    client = 'second'
    assert.equal((await fetch(`${url}/file`)).status, 200)

    client = 'first'
    release()
    assert.equal((await held).status, 200)
    assert.equal((await fetch(`${url}/file`)).status, 200)
  })
})
