import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import cors from 'cors'
import express, { Router, type Express } from 'express'
import multer from 'multer'
import { mountApiRoutes } from '../src/security/accessPolicy.js'
import { createApiKeyAuth } from '../src/security/apiKey.js'
import { validateSecurityConfig } from '../src/security/config.js'
import {
  createCorsOriginDelegate,
  createCorsOriginRewriteMiddleware,
  createOriginMatcher
} from '../src/security/cors.js'
import { getPublicError, InvalidRequestError } from '../src/security/errors.js'
import { createRateLimiter } from '../src/security/rateLimit.js'
import { parseTrustProxy } from '../src/security/trustProxy.js'
import { createMultipartLimits } from '../src/security/uploadLimits.js'
import { FileLifecycleBusyError } from '../src/storage/registry.js'
import { FileNotFoundError } from '../src/utils/fileErrors.js'

describe('CORS origin policy', () => {
  const matches = createOriginMatcher([
    'https://adm.im',
    'https://*.adamant.im',
    'http://localhost:8080',
    'app://.',
    'app://localhost'
  ])

  it('accepts exact and wildcard subdomain origins', () => {
    assert.equal(matches('https://adm.im'), true)
    assert.equal(matches('https://chat.adamant.im'), true)
    assert.equal(matches('https://nested.chat.adamant.im'), true)
    assert.equal(matches('http://localhost:8080'), true)
  })

  it('accepts a configured desktop origin and no other app host', () => {
    assert.equal(matches('app://.'), true)
    assert.equal(matches('app://localhost'), true)
    assert.equal(matches('APP://.'), true)
    assert.equal(matches('app://bundle'), false)
    assert.equal(matches('app://.evil.example'), false)
    assert.equal(matches('app://./'), false)
    assert.equal(matches('app://./index.html'), false)
    assert.equal(matches('app://user@.'), false)
  })

  it('rejects suffix confusion, paths, and unlisted schemes', () => {
    assert.equal(matches('https://adamant.im.evil.example'), false)
    assert.equal(matches('https://adamant.im'), false)
    assert.equal(matches('https://chat.adamant.im/path'), false)
    assert.equal(matches('http://chat.adamant.im'), false)
    assert.equal(matches('file:///'), false)
    assert.equal(matches('null'), false)
  })

  it('accepts the opaque browser origin when null is configured', () => {
    const opaque = createOriginMatcher(['https://adm.im', 'null'])
    assert.equal(opaque('null'), true)
    assert.equal(opaque('https://adm.im'), true)
    assert.equal(opaque('https://evil.example'), false)
  })

  it('accepts http://*.onion for v3 hidden-service origins', () => {
    const tor = createOriginMatcher(['http://*.onion'])
    const pwa = 'http://adamant6457join2rxdkr2y7iqatar7n4n72lordxeknj435i4cjhpyd.onion'
    const ipfs = 'http://z455rax4mwcseyc7efog7czrbwdvphwocatl5sjcc6htcoj2k2vz7dad.onion'

    assert.equal(tor(pwa), true)
    assert.equal(tor(ipfs), true)
    assert.equal(tor('http://short.onion'), false)
    assert.equal(
      tor('https://z455rax4mwcseyc7efog7czrbwdvphwocatl5sjcc6htcoj2k2vz7dad.onion'),
      false
    )
    assert.equal(tor('http://notadamant.im'), false)
  })

  it('parses http://*.onion at startup', () => {
    assert.doesNotThrow(() => createOriginMatcher(['http://*.onion', 'https://*.onion']))
    assert.throws(() => createOriginMatcher(['http://*..onion']))
  })

  it('rejects invalid configured origin rules', () => {
    assert.throws(() => createOriginMatcher(['*']))
    assert.throws(() => createOriginMatcher(['https://example.org/path']))
    assert.throws(() => createOriginMatcher(['https://*example.org']))
    assert.throws(() => createOriginMatcher(['app://*']))
    assert.throws(() => createOriginMatcher(['app://*.localhost']))
    assert.throws(() => createOriginMatcher(['app://./']))
    assert.throws(() => createOriginMatcher(['APP://.']))
    assert.throws(() => createOriginMatcher(['file:///']))
    assert.throws(() => createOriginMatcher(['app://localhost:80']))
  })

  it('emits an allow-origin header only for an accepted browser origin', async () => {
    const app = express()
    app.use(cors({ origin: createCorsOriginDelegate(['https://adm.im']) }))
    app.get('/', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const allowed = await fetch(server.url, { headers: { origin: 'https://adm.im' } })
      const rejected = await fetch(server.url, { headers: { origin: 'https://evil.example' } })
      const desktop = await fetch(server.url, { headers: { origin: 'app://.' } })

      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://adm.im')
      assert.equal(rejected.headers.get('access-control-allow-origin'), null)
      assert.equal(desktop.headers.get('access-control-allow-origin'), null)
    } finally {
      await server.close()
    }
  })

  it('reflects Access-Control-Allow-Origin * when the browser sends Origin null', async () => {
    const app = express()
    app.use(cors({ origin: createCorsOriginDelegate(['null']) }))
    app.get('/api/node/info', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/api/node/info`, { headers: { origin: 'null' } })
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
    } finally {
      await server.close()
    }
  })

  it('uses Access-Control-Allow-Origin * when Origin is null without Referer', async () => {
    const app = express()
    app.use(cors({ origin: createCorsOriginDelegate(['http://*.onion']) }))
    app.get('/api/node/info', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/api/node/info`, { headers: { origin: 'null' } })
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
    } finally {
      await server.close()
    }
  })

  it('rewrites Origin null to an allowlisted Referer origin for Tor cross-onion calls', async () => {
    const allowed = ['http://*.onion', 'null']
    const pwa = 'http://adamant6457join2rxdkr2y7iqatar7n4n72lordxeknj435i4cjhpyd.onion'
    const app = express()
    app.use(createCorsOriginRewriteMiddleware(allowed))
    app.use(cors({ origin: createCorsOriginDelegate(allowed) }))
    app.get('/api/node/info', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const response = await fetch(`${server.url}/api/node/info`, {
        headers: {
          origin: 'null',
          referer: `${pwa}/options/nodes`
        }
      })
      assert.equal(response.headers.get('access-control-allow-origin'), pwa)
    } finally {
      await server.close()
    }
  })

  it('allows a configured app://. origin on info and upload, including preflight', async () => {
    const app = express()
    app.use(
      cors({
        origin: createCorsOriginDelegate(['https://*.adamant.im', 'app://.']),
        credentials: false,
        methods: ['GET', 'POST'],
        allowedHeaders: ['content-type', 'x-api-key'],
        maxAge: 600
      })
    )
    app.get('/api/node/info', (req, res) => res.send({ ok: true }))
    app.post('/api/file/upload', (req, res) => res.send({ ok: true }))
    const server = await startServer(app)

    try {
      const info = await fetch(`${server.url}/api/node/info`, { headers: { origin: 'app://.' } })
      const preflight = await fetch(`${server.url}/api/file/upload`, {
        method: 'OPTIONS',
        headers: {
          origin: 'app://.',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type'
        }
      })
      const upload = await fetch(`${server.url}/api/file/upload`, {
        method: 'POST',
        headers: { origin: 'app://.', 'content-type': 'text/plain' },
        body: 'desktop'
      })
      const otherHost = await fetch(`${server.url}/api/node/info`, {
        headers: { origin: 'app://localhost' }
      })
      const wildcard = await fetch(`${server.url}/api/node/info`, {
        headers: { origin: 'https://msg.adamant.im' }
      })

      assert.equal(info.status, 200)
      assert.equal(info.headers.get('access-control-allow-origin'), 'app://.')
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'app://.')
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/)
      assert.equal(upload.status, 200)
      assert.equal(upload.headers.get('access-control-allow-origin'), 'app://.')
      assert.equal(otherHost.headers.get('access-control-allow-origin'), null)
      assert.equal(wildcard.headers.get('access-control-allow-origin'), 'https://msg.adamant.im')
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
    assert.doesNotThrow(() =>
      validateSecurityConfig({
        ...baseConfig,
        cors: { allowedOrigins: ['https://adm.im', 'app://.'] }
      })
    )
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
      body: { error: 'File request timed out', code: 'file_timeout' }
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

  it('reports an active lifecycle without exposing transaction details', () => {
    assert.deepEqual(getPublicError(new FileLifecycleBusyError('secret-cid')), {
      status: 409,
      body: { error: 'File lifecycle is busy', code: 'lifecycle_busy' }
    })
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
    assert.deepEqual(await response.json(), {
      error: 'Multipart fields are not allowed',
      code: 'multipart_fields'
    })
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
    const fileAdminRouter = Router().post('/test/confirm', (req, res) => res.send({ admin: true }))
    const publicNodeRouter = Router()
      .get('/health', (req, res) => res.send({ public: true }))
      .get('/info', (req, res) => res.send({ legacy: true }))
    const node = Router()
      .get('/details', (req, res) => res.send({ admin: true }))
      .get('/future', (req, res) => res.send({ admin: true }))
    const helia = Router().get('/test', (req, res) => res.send({ admin: true }))
    const libp2p = Router().get('/test', (req, res) => res.send({ admin: true }))
    const debug = Router().get('/test', (req, res) => res.send({ admin: true }))
    const storage = Router().get('/metrics', (req, res) => res.send({ public: true }))
    const storageAdminRouter = Router().post('/gc', (req, res) => res.send({ admin: true }))

    mountApiRoutes(
      app,
      {
        file,
        fileAdminRouter,
        publicNodeRouter,
        node,
        helia,
        libp2p,
        debug,
        storage,
        storageAdminRouter
      },
      createApiKeyAuth(key),
      false
    )

    const server = await startServer(app)
    serverUrl = server.url
    closeServer = server.close
  })

  after(async () => closeServer?.())

  it('keeps health, file transfer, and the storage report public', async () => {
    assert.equal((await fetch(`${serverUrl}/api/node/health`)).status, 200)
    assert.equal((await fetch(`${serverUrl}/api/node/info`)).status, 200)
    assert.equal((await fetch(`${serverUrl}/api/file/test`)).status, 200)
    assert.equal((await fetch(`${serverUrl}/api/storage/metrics`)).status, 200)
  })

  it('keeps detailed node identity behind the administrative key', async () => {
    assert.equal((await fetch(`${serverUrl}/api/node/details`)).status, 401)
    assert.equal(
      (
        await fetch(`${serverUrl}/api/node/details`, {
          headers: { 'x-api-key': key }
        })
      ).status,
      200
    )
  })

  it('protects the routes that make content durable or reclaim it', async () => {
    for (const path of ['/api/file/test/confirm', '/api/storage/gc']) {
      assert.equal((await fetch(`${serverUrl}${path}`, { method: 'POST' })).status, 401)
      assert.equal(
        (await fetch(`${serverUrl}${path}`, { method: 'POST', headers: { 'x-api-key': key } }))
          .status,
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
        fileAdminRouter: emptyRouter,
        publicNodeRouter: emptyRouter,
        node: emptyRouter,
        helia: emptyRouter,
        libp2p: emptyRouter,
        debug,
        storage: emptyRouter,
        storageAdminRouter: emptyRouter
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
    const limited = await fetch(`${serverUrl}/upload`, { headers: firstClient })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), {
      error: 'Too many requests. Please try again later.',
      code: 'rate_limited'
    })
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.match(limited.headers.get('ratelimit') ?? '', /r=0/)
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
