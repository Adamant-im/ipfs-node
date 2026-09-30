import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { httpLogSerializers, routeShape } from '../src/utils/logger.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

describe('request logging', () => {
  it('masks every segment that is not part of a route', () => {
    assert.equal(routeShape(`/api/file/${CID}`), '/api/file/:param')
    assert.equal(routeShape(`/api/file/${CID}/status`), '/api/file/:param/status')
    assert.equal(routeShape(`/api/helia/pins/isPinned/${CID}`), '/api/helia/pins/isPinned/:param')
  })

  it('keeps static routes readable', () => {
    assert.equal(routeShape('/api/node/health'), '/api/node/health')
    assert.equal(routeShape('/api/storage/policy'), '/api/storage/policy')
    assert.equal(routeShape('/'), '/')
    assert.equal(routeShape(undefined), '/')
  })

  it('drops the query string, which is user input like any other', () => {
    assert.equal(routeShape('/api/storage/gc?dryRun=true'), '/api/storage/gc')
    assert.equal(routeShape(`/api/file/${CID}?token=secret`), '/api/file/:param')
  })

  it('serializes a request without its headers or CID', () => {
    const serialized = httpLogSerializers.req({
      method: 'GET',
      url: `/api/file/${CID}`,
      // Present on the real request object; must not reach the log.
      headers: { 'x-api-key': 'a'.repeat(64), authorization: 'Bearer token' }
    } as unknown as { method?: string; url?: string })

    assert.deepEqual(serialized, { method: 'GET', url: '/api/file/:param' })
    assert.equal(JSON.stringify(serialized).includes('a'.repeat(64)), false)
    assert.equal(JSON.stringify(serialized).includes(CID), false)
  })

  it('serializes a response without the CID-bearing headers', () => {
    const serialized = httpLogSerializers.res({
      statusCode: 200,
      headers: { etag: `"${CID}"`, 'content-disposition': `attachment; filename="${CID}"` }
    } as unknown as { statusCode?: number })

    assert.deepEqual(serialized, { statusCode: 200 })
    assert.equal(JSON.stringify(serialized).includes(CID), false)
  })
})
