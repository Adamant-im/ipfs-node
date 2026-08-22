import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, config, configFileName, validateConfig } from '../src/config.js'

/** A minimal config that passes validation; individual tests break one field. */
function validRaw(): Record<string, unknown> {
  return {
    nodes: [{ name: 'ipfs1', multiAddr: '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWTest' }],
    storeFolder: '.adm-ipfs',
    logLevel: 'debug',
    peerDiscovery: {
      bootstrap: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWTest'],
      listen: ['/ip4/0.0.0.0/tcp/4001']
    },
    serverPort: 4000,
    diskUsageScanPeriod: '*/30 * * * * *',
    uploadLimitSizeBytes: 268435456,
    maxFileCount: 10,
    findFileTimeout: 20000,
    cors: { allowedOrigins: ['https://adm.im'] },
    trustProxy: false,
    adminApiKey: '',
    enableDebugApi: false
  }
}

describe('configFileName', () => {
  it('defaults to config.json5', () => {
    assert.equal(configFileName(), 'config.json5')
    assert.equal(configFileName(''), 'config.json5')
    assert.equal(configFileName(undefined), 'config.json5')
  })

  it('maps a name to the documented config.<name>.json5 form', () => {
    assert.equal(configFileName('test1'), 'config.test1.json5')
    assert.equal(configFileName('default'), 'config.default.json5')
  })
})

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    const parsed = validateConfig(validRaw())

    assert.equal(parsed.serverPort, 4000)
    assert.equal(parsed.nodes.length, 1)
    assert.equal(parsed.nodes[0].name, 'ipfs1')
    assert.deepEqual(parsed.peerDiscovery.listen, ['/ip4/0.0.0.0/tcp/4001'])
    assert.deepEqual(parsed.cors.allowedOrigins, ['https://adm.im'])
    assert.equal(parsed.enableDebugApi, false)
  })

  it('ignores unknown keys so deployments can carry extras', () => {
    assert.doesNotThrow(() => validateConfig({ ...validRaw(), someFutureOption: 42 }))
  })

  const invalidCases: Array<[string, (raw: Record<string, unknown>) => void, RegExp]> = [
    ['nodes is missing', (raw) => delete raw.nodes, /nodes/],
    [
      'a node has no multiAddr',
      (raw) => {
        raw.nodes = [{ name: 'ipfs1' }]
      },
      /nodes\[0\]\.multiAddr/
    ],
    [
      'storeFolder is empty',
      (raw) => {
        raw.storeFolder = ''
      },
      /storeFolder/
    ],
    [
      'logLevel is not a pino level',
      (raw) => {
        raw.logLevel = 'verbose'
      },
      /logLevel/
    ],
    [
      'listen is empty',
      (raw) => {
        raw.peerDiscovery = { bootstrap: [], listen: [] }
      },
      /peerDiscovery\.listen/
    ],
    [
      'bootstrap contains a non-string',
      (raw) => {
        raw.peerDiscovery = { bootstrap: [42], listen: ['/ip4/0.0.0.0/tcp/4001'] }
      },
      /peerDiscovery\.bootstrap\[0\]/
    ],
    [
      'serverPort is not an integer',
      (raw) => {
        raw.serverPort = 4000.5
      },
      /serverPort/
    ],
    [
      'diskUsageScanPeriod is missing',
      (raw) => delete raw.diskUsageScanPeriod,
      /diskUsageScanPeriod/
    ],
    [
      'findFileTimeout is negative',
      (raw) => {
        raw.findFileTimeout = -1
      },
      /findFileTimeout/
    ]
  ]

  for (const [description, mutate, expected] of invalidCases) {
    it(`rejects a config where ${description}`, () => {
      const raw = validRaw()
      mutate(raw)

      assert.throws(
        () => validateConfig(raw),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError)
          assert.match(err.message, expected)
          return true
        }
      )
    })
  }

  it('rejects a config that is not an object', () => {
    assert.throws(() => validateConfig(null), ConfigError)
    assert.throws(() => validateConfig([]), ConfigError)
  })

  it('delegates the security surface to validateSecurityConfig', () => {
    // Not a ConfigError: the security validator owns these fields and its
    // messages are asserted in security.test.ts
    assert.throws(() => validateConfig({ ...validRaw(), trustProxy: true }), /trustProxy/)
    assert.throws(() => validateConfig({ ...validRaw(), maxFileCount: 0 }), /maxFileCount/)
    assert.throws(
      () => validateConfig({ ...validRaw(), cors: { allowedOrigins: ['*'] } }),
      /origin/i
    )
  })
})

describe('the config loaded at startup', () => {
  it('is validated and exposes the test configuration', () => {
    assert.equal(config.logLevel, 'silent')
    assert.deepEqual(config.peerDiscovery.bootstrap, [])
    assert.equal(config.enableDebugApi, false)
  })
})
