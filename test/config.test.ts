import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, config, configFileName, validateConfig } from '../src/config.js'

const PEER_ID = '12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq'

/** A minimal config that passes validation; individual tests break one field. */
function validRaw(): Record<string, unknown> {
  return {
    nodes: [{ name: 'ipfs1', multiAddr: `/ip4/127.0.0.1/tcp/4001/p2p/${PEER_ID}` }],
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
    assert.equal(parsed.prettyLogs, false)
    assert.equal(parsed.health.checkpointIntervalMs, 60_000)
    assert.equal(parsed.health.requiredPeerCount, 0)
    assert.equal(parsed.downloadIdleTimeout, 20_000)
    assert.equal(parsed.downloadMinBytesPerSecond, 32 * 1024)
    assert.equal(parsed.downloadMaxDurationMs, 4 * 60 * 60 * 1_000)
    assert.equal(parsed.storage.maxConcurrentDownloadsPerClient, 8)
  })

  it('keeps a configuration written before the download options valid', () => {
    // 512 MiB at the fallback 32 KiB/s needs more than the four-hour floor, so
    // the ceiling has to follow the existing upload limit rather than reject it.
    const raw = validRaw()
    raw.uploadLimitSizeBytes = 536_870_912
    raw.storage = { maxRequestSizeBytes: 536_870_912 }
    const parsed = validateConfig(raw)

    assert.equal(parsed.downloadMaxDurationMs, Math.ceil(536_870_912 / 32_768) * 1_000 + 20_000)
  })

  it('ignores unknown keys so deployments can carry extras', () => {
    assert.doesNotThrow(() => validateConfig({ ...validRaw(), someFutureOption: 42 }))
  })

  it('rejects two configured addresses for the same peer identity', () => {
    const raw = validRaw()
    raw.nodes = [
      { name: 'ipfs1', multiAddr: `/ip4/127.0.0.1/tcp/4001/p2p/${PEER_ID}` },
      { name: 'ipfs1-alias', multiAddr: `/ip4/127.0.0.2/tcp/4001/p2p/${PEER_ID}` }
    ]

    assert.throws(() => validateConfig(raw), /must identify a unique peer/)
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
    ],
    [
      'download idle timeout is invalid',
      (raw) => {
        raw.downloadIdleTimeout = 0
      },
      /downloadIdleTimeout/
    ],
    [
      'download minimum throughput is invalid',
      (raw) => {
        raw.downloadMinBytesPerSecond = 0
      },
      /downloadMinBytesPerSecond/
    ],
    [
      'download maximum duration is below the idle timeout',
      (raw) => {
        raw.downloadMaxDurationMs = 1
      },
      /downloadMaxDurationMs/
    ],
    [
      'download ceiling cannot carry the largest permitted file',
      (raw) => {
        // 256 MiB at 32 KiB/s needs 8192 s; a one-minute ceiling would cut it off.
        raw.downloadMaxDurationMs = 60_000
      },
      /downloadMaxDurationMs/
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

  it('rejects strict quorum while confirmation is still required', () => {
    assert.throws(
      () =>
        validateConfig({
          ...validRaw(),
          storage: { confirmationRequired: true },
          replication: { ackQuorum: 2, requireQuorumOnUpload: true }
        }),
      /requireQuorumOnUpload/
    )
  })

  it('validates health timing and peer coverage', () => {
    assert.throws(
      () => validateConfig({ ...validRaw(), health: { checkpointIntervalMs: 999 } }),
      /health\.checkpointIntervalMs/
    )
    assert.throws(
      () => validateConfig({ ...validRaw(), health: { requiredPeerCount: 1 } }),
      /health\.requiredPeerCount/
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
