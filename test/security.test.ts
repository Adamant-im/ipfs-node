import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import cors from 'cors'
import express, { Router, type Express } from 'express'
import multer from 'multer'
import { mountApiRoutes } from '../src/security/accessPolicy.js'
import { createApiKeyAuth } from '../src/security/apiKey.js'
import { validateSecurityConfig } from '../src/security/config.js'
import { createCorsOriginDelegate, createOriginMatcher } from '../src/security/cors.js'
import { getPublicError, InvalidRequestError } from '../src/security/errors.js'
import { createRateLimiter } from '../src/security/rateLimit.js'
import { parseTrustProxy } from '../src/security/trustProxy.js'
import { createMultipartLimits } from '../src/security/uploadLimits.js'
import { FileNotFoundError } from '../src/utils/fileErrors.js'

describe('CORS origin policy', () => {
  const matches = createOriginMatcher([
    'https://adm.im',
    'https://*.adamant.im',
    'http://localhost:8080'
  ])

  it('accepts exact and wildcard subdomain origins', () => {
    assert.equal(matches('https://adm.im'), true)
    assert.equal(matches('https://chat.adamant.im'), true)
    assert.equal(matches('https://nested.chat.adamant.im'), true)
    assert.equal(matches('http://localhost:8080'), true)
  })

  it('rejects suffix confusion, paths, and unlisted schemes', () => {
    assert.equal(matches('https://adamant.im.evil.example'), false)
    assert.equal(matches('https://adamant.im'), false)
    assert.equal(matches('https://chat.adamant.im/path'), false)
    assert.equal(matches('http://chat.adamant.im'), false)
  })

  it('rejects invalid configured origin rules', () => {
    assert.throws(() => createOriginMatcher(['*']))
    assert.throws(() => createOriginMatcher(['https://example.org/path']))
    assert.throws(() => createOriginMatcher(['https://*example.org']))
  })

  it('emits an allow-origin header only for an accepted browser origin', async () => {
    const app = express()
    app.use(cors({ origin: createCorsOriginDelegate(['https://adm.im']) }))
    app.get('/', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const allowed = await fetch(server.url, { headers: { origin: 'https://adm.im' } })
      const rejected = await fetch(server.url, { headers: { origin: 'https://evil.example' } })

      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://adm.im')
      assert.equal(rejected.headers.get('access-control-allow-origin'), null)
    } finally {
      await server.close()
    }
  })
})

describe('security configuration', () => {
  const baseConfig = {
    cors: { allowedOrigins: ['https://adm.im'] },
    trustProxy: false,
    adminApiKey: '',
    enableDebugApi: false,
    uploadLimitSizeBytes: 1024,
    maxFileCount: 10
  }

  it('accepts a fail-closed default configuration', () => {
    assert.doesNotThrow(() => validateSecurityConfig(baseConfig))
  })

  it('rejects unsafe proxy trust and placeholder admin keys', () => {
    assert.throws(() => validateSecurityConfig({ ...baseConfig, trustProxy: true }))
    assert.throws(() => validateSecurityConfig({ ...baseConfig, trustProxy: '0.0.0.0/0' }))
    assert.throws(() =>
      validateSecurityConfig({
        ...baseConfig,
        adminApiKey: 'change-me-use-openssl-rand-hex-32'
      })
    )
  })

  it('rejects disabled or unreasonably broad upload limits', () => {
    assert.throws(() => validateSecurityConfig({ ...baseConfig, uploadLimitSizeBytes: 0 }))
    assert.throws(() => validateSecurityConfig({ ...baseConfig, maxFileCount: 101 }))
  })
})

describe('public error mapping', () => {
  it('does not expose messages from unexpected exceptions', () => {
    const result = getPublicError(new Error('/srv/private/blockstore failed with secret'))

    assert.deepEqual(result, {
      status: 500,
      body: { error: 'Internal Server Error' }
    })
  })

  it('returns only an approved validation message', () => {
    assert.deepEqual(getPublicError(new InvalidRequestError('Invalid CID')), {
      status: 400,
      body: { error: 'Invalid CID' }
    })
  })

  it('preserves the public timeout response without exposing internal details', () => {
    assert.deepEqual(getPublicError(new FileNotFoundError('/private/path was not found')), {
      status: 408,
      body: { error: 'File request timed out' }
    })
  })

  it('maps peer input failures to controlled validation responses', () => {
    assert.deepEqual(
      getPublicError(new InvalidRequestError('Invalid peer identifier or multiaddress')),
      {
        status: 400,
        body: { error: 'Invalid peer identifier or multiaddress' }
      }
    )
  })
})

describe('streaming multipart limits', () => {
  const app = express()
  let serverUrl = ''
  let closeServer: (() => Promise<void>) | undefined

  before(async () => {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: createMultipartLimits(1024, 2)
    }).array('files')
    app.post('/upload', upload, (req, res) => res.send({ ok: true }))
    app.use(
      (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
        void req
        void _next
        const publicError = getPublicError(err)
        res.status(publicError.status).send(publicError.body)
      }
    )

    const server = await startServer(app)
    serverUrl = server.url
    closeServer = server.close
  })

  after(async () => closeServer?.())

  it('accepts the configured maximum and rejects the next file while streaming', async () => {
    assert.equal((await sendFiles(serverUrl, 2)).status, 200)
    assert.equal((await sendFiles(serverUrl, 3)).status, 400)
  })

  it('rejects text fields with a dedicated public response', async () => {
    const response = await sendFiles(serverUrl, 1, true)

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Multipart fields are not allowed' })
  })
})

describe('administrative API key', () => {
  const key = 'a'.repeat(64)
  const app = express()
  let serverUrl = ''
  let closeServer: (() => Promise<void>) | undefined

  before(async () => {
    app.get('/admin', createApiKeyAuth(key), (req, res) => res.send({ ok: true }))
    app.get('/disabled', createApiKeyAuth(''), (req, res) => res.send({ ok: true }))
    const server = await startServer(app)
    serverUrl = server.url
    closeServer = server.close
  })

  after(async () => closeServer?.())

  it('rejects missing and invalid keys and accepts the configured key', async () => {
    assert.equal((await fetch(`${serverUrl}/disabled`)).status, 503)
    assert.equal((await fetch(`${serverUrl}/admin`)).status, 401)
    assert.equal(
      (await fetch(`${serverUrl}/admin`, { headers: { 'x-api-key': 'invalid' } })).status,
      401
    )
    assert.equal((await fetch(`${serverUrl}/admin`, { headers: { 'x-api-key': key } })).status, 200)
    assert.equal(
      (await fetch(`${serverUrl}/admin`, { headers: { 'x-api-key': key } })).headers.get(
        'cache-control'
      ),
      'no-store'
    )
  })
})

describe('route access policy', () => {
  const key = 'b'.repeat(64)
  const app = express()
  let serverUrl = ''
  let closeServer: (() => Promise<void>) | undefined

  before(async () => {
    const file = Router().get('/test', (req, res) => res.send({ public: true }))
    const publicNodeRouter = Router().get('/health', (req, res) => res.send({ public: true }))
    const node = Router()
      .get('/info', (req, res) => res.send({ admin: true }))
      .get('/future', (req, res) => res.send({ admin: true }))
    const helia = Router().get('/test', (req, res) => res.send({ admin: true }))
    const libp2p = Router().get('/test', (req, res) => res.send({ admin: true }))
    const debug = Router().get('/test', (req, res) => res.send({ admin: true }))

    mountApiRoutes(
      app,
      { file, publicNodeRouter, node, helia, libp2p, debug },
      createApiKeyAuth(key),
      false
    )

    const server = await startServer(app)
    serverUrl = server.url
    closeServer = server.close
  })

  after(async () => closeServer?.())

  it('keeps health and file transfer public', async () => {
    assert.equal((await fetch(`${serverUrl}/api/node/health`)).status, 200)
    assert.equal((await fetch(`${serverUrl}/api/file/test`)).status, 200)
  })

  it('protects node information, Helia, and libp2p routes', async () => {
    for (const path of [
      '/api/node/info',
      '/api/node/future',
      '/api/helia/test',
      '/api/libp2p/test'
    ]) {
      assert.equal((await fetch(`${serverUrl}${path}`)).status, 401)
      assert.equal(
        (await fetch(`${serverUrl}${path}`, { headers: { 'x-api-key': key } })).status,
        200
      )
    }
  })

  it('does not mount the debug API by default', async () => {
    assert.equal((await fetch(`${serverUrl}/api/debug/test`)).status, 404)
  })

  it('protects the debug API when explicitly enabled', async () => {
    const debugApp = express()
    const debug = Router().get('/test', (req, res) => res.send({ admin: true }))
    const emptyRouter = Router()
    mountApiRoutes(
      debugApp,
      {
        file: emptyRouter,
        publicNodeRouter: emptyRouter,
        node: emptyRouter,
        helia: emptyRouter,
        libp2p: emptyRouter,
        debug
      },
      createApiKeyAuth(key),
      true
    )
    const server = await startServer(debugApp)

    try {
      assert.equal((await fetch(`${server.url}/api/debug/test`)).status, 401)
      assert.equal(
        (
          await fetch(`${server.url}/api/debug/test`, {
            headers: { 'x-api-key': key }
          })
        ).status,
        200
      )
    } finally {
      await server.close()
    }
  })
})

describe('rate limiting behind a trusted proxy', () => {
  const app = express()
  let serverUrl = ''
  let closeServer: (() => Promise<void>) | undefined

  before(async () => {
    app.set('trust proxy', parseTrustProxy('loopback'))
    app.get('/upload', createRateLimiter({ windowMs: 60_000, limit: 1 }), (req, res) =>
      res.send({ ok: true })
    )
    const server = await startServer(app)
    serverUrl = server.url
    closeServer = server.close
  })

  after(async () => closeServer?.())

  it('keys limits by the validated forwarded client address', async () => {
    const firstClient = { 'x-forwarded-for': '198.51.100.10' }
    const secondClient = { 'x-forwarded-for': '198.51.100.11' }

    assert.equal((await fetch(`${serverUrl}/upload`, { headers: firstClient })).status, 200)
    assert.equal((await fetch(`${serverUrl}/upload`, { headers: firstClient })).status, 429)
    assert.equal((await fetch(`${serverUrl}/upload`, { headers: secondClient })).status, 200)
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

async function sendFiles(
  serverUrl: string,
  count: number,
  includeTextField = false
): Promise<Response> {
  const body = new FormData()
  for (let index = 0; index < count; index += 1) {
    body.append('files', new Blob([String(index)]), `${index}.txt`)
  }
  if (includeTextField) {
    body.append('description', 'not accepted')
  }
  return fetch(`${serverUrl}/upload`, { method: 'POST', body })
}
