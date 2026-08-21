import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ConfigError, config, configFileName, validateConfig } from '../../config.js'

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
    cors: { origin: '*', credentials: true }
  }
}

describe('configFileName', () => {
  test('defaults to config.json5', () => {
    assert.equal(configFileName(), 'config.json5')
    assert.equal(configFileName(''), 'config.json5')
    assert.equal(configFileName(undefined), 'config.json5')
  })

  test('maps a name to the documented config.<name>.json5 form', () => {
    assert.equal(configFileName('test1'), 'config.test1.json5')
    assert.equal(configFileName('default'), 'config.default.json5')
  })
})

describe('validateConfig', () => {
  test('accepts a complete config', () => {
    const parsed = validateConfig(validRaw())

    assert.equal(parsed.serverPort, 4000)
    assert.equal(parsed.nodes.length, 1)
    assert.equal(parsed.nodes[0].name, 'ipfs1')
    assert.deepEqual(parsed.peerDiscovery.listen, ['/ip4/0.0.0.0/tcp/4001'])
    assert.equal(parsed.cors.origin, '*')
  })

  test('ignores unknown keys so deployments can carry extras', () => {
    const raw = { ...validRaw(), someFutureOption: 42 }

    assert.doesNotThrow(() => validateConfig(raw))
  })

  test('accepts an array of CORS origins', () => {
    const raw = { ...validRaw(), cors: { origin: ['a.example', 'b.example'], credentials: false } }

    assert.deepEqual(validateConfig(raw).cors.origin, ['a.example', 'b.example'])
  })

  const invalidCases: Array<[string, (raw: Record<string, unknown>) => void, string]> = [
    ['nodes is missing', (raw) => delete raw.nodes, 'nodes'],
    [
      'a node has no multiAddr',
      (raw) => {
        raw.nodes = [{ name: 'ipfs1' }]
      },
      'nodes[0].multiAddr'
    ],
    [
      'storeFolder is empty',
      (raw) => {
        raw.storeFolder = ''
      },
      'storeFolder'
    ],
    [
      'logLevel is not a pino level',
      (raw) => {
        raw.logLevel = 'verbose'
      },
      'logLevel'
    ],
    [
      'listen is empty',
      (raw) => {
        raw.peerDiscovery = { bootstrap: [], listen: [] }
      },
      'peerDiscovery.listen'
    ],
    [
      'bootstrap contains a non-string',
      (raw) => {
        raw.peerDiscovery = { bootstrap: [42], listen: ['/ip4/0.0.0.0/tcp/4001'] }
      },
      'peerDiscovery.bootstrap[0]'
    ],
    [
      'serverPort is not an integer',
      (raw) => {
        raw.serverPort = 4000.5
      },
      'serverPort'
    ],
    [
      'maxFileCount is zero',
      (raw) => {
        raw.maxFileCount = 0
      },
      'maxFileCount'
    ],
    [
      'findFileTimeout is negative',
      (raw) => {
        raw.findFileTimeout = -1
      },
      'findFileTimeout'
    ],
    [
      'cors.credentials is not a boolean',
      (raw) => {
        raw.cors = { origin: '*', credentials: 'yes' }
      },
      'cors.credentials'
    ],
    [
      'cors.origin has the wrong type',
      (raw) => {
        raw.cors = { origin: 42, credentials: true }
      },
      'cors.origin'
    ]
  ]

  for (const [description, mutate, expectedPath] of invalidCases) {
    test(`rejects a config where ${description}`, () => {
      const raw = validRaw()
      mutate(raw)

      assert.throws(
        () => validateConfig(raw),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError)
          assert.match(err.message, new RegExp(expectedPath.replace(/[[\]]/g, '\\$&')))
          return true
        }
      )
    })
  }

  test('rejects a config that is not an object', () => {
    assert.throws(() => validateConfig(null), ConfigError)
    assert.throws(() => validateConfig([]), ConfigError)
  })
})

describe('the config loaded at startup', () => {
  test('is validated and exposes the test configuration', () => {
    assert.equal(config.logLevel, 'silent')
    assert.deepEqual(config.peerDiscovery.bootstrap, [])
  })
})
