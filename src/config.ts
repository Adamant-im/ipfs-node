import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import JSON5 from 'json5'
import { validateSecurityConfig } from './security/config.js'
import type { RateLimitPolicy } from './security/rateLimit.js'
import type { TrustProxySetting } from './security/trustProxy.js'
import {
  resolveReplicationConfig,
  resolveStorageConfig,
  type ReplicationConfig,
  type StorageConfig
} from './storage/config.js'

/**
 * Locate the repository root by walking up to the nearest `package.json`.
 *
 * The compiled entry point sits at `dist/config.js`, but the test build emits
 * to `dist-test/src/config.js`, so a fixed number of `..` segments resolves the
 * root correctly for only one of them.
 */
function findRootDir(start: string): string {
  let dir = start

  for (;;) {
    if (fs.existsSync(join(dir, 'package.json'))) {
      return dir
    }

    const parent = dirname(dir)
    if (parent === dir) {
      throw new ConfigError(`Cannot locate the project root above ${start}`)
    }
    dir = parent
  }
}

const currDir = dirname(fileURLToPath(import.meta.url))

/** Redial unconnected ADAMANT nodes every half minute unless configured otherwise. */
const DEFAULT_PEERING_SCHEDULE = '*/30 * * * * *'

/** Log levels accepted by `pino`, ordered from least to most verbose. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** A known ADAMANT IPFS node this node peers with. */
export interface ConfigNode {
  name: string
  multiAddr: string
}

export interface Config {
  /** Known ADAMANT IPFS nodes. Their multiaddrs are also the connection manager allow list. */
  nodes: ConfigNode[]
  /** File storage directory, resolved from the user's home directory. */
  storeFolder: string
  logLevel: LogLevel
  peerDiscovery: {
    /** Multiaddrs dialled on startup to join the ADAMANT peer set. */
    bootstrap: string[]
    /** Multiaddrs libp2p listens on. */
    listen: string[]
  }
  /** API server port. */
  serverPort: number
  /** Disk space scanning period in cron format. */
  diskUsageScanPeriod: string
  /**
   * How often the node redials the peers in `nodes` that are not connected,
   * in cron format. Bootstrap only dials once, so without this a mesh never
   * recovers from a restart.
   */
  peeringSchedule: string
  /** Maximum size of a single uploaded file, in bytes. */
  uploadLimitSizeBytes: number
  /** Maximum number of files accepted per upload request. */
  maxFileCount: number
  /** Time limit, in milliseconds, for locating a file on the IPFS network. */
  findFileTimeout: number
  cors: {
    /** Exact origins and left-most subdomain wildcards; see `src/security/cors.ts`. */
    allowedOrigins: string[]
  }
  trustProxy: TrustProxySetting
  rateLimits?: Partial<Record<'upload' | 'pin' | 'read', RateLimitPolicy>>
  /** Administrative API key. An empty value makes administrative routes fail closed. */
  adminApiKey: string
  enableDebugApi: boolean
  /** Bounded storage lifecycle; see `src/storage/config.ts`. */
  storage: StorageConfig
  /** Cross-node durability policy; see `src/storage/config.ts`. */
  replication: ReplicationConfig
}

/**
 * Build the config file name for an optional config suffix.
 *
 * Passing `test1` selects `config.test1.json5`; passing nothing selects `config.json5`.
 * This mirrors the documented `node dist/index.js <name>` invocation.
 *
 * @param name Config suffix taken from `IPFS_NODE_CONFIG` or the first CLI argument
 */
export function configFileName(name?: string): string {
  return name != null && name !== '' ? `config.${name}.json5` : 'config.json5'
}

/** Thrown when the config file is missing, unparseable, or fails validation. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Repository root; config files and `package.json` are read from here. */
const rootDir = findRootDir(currDir)

function fail(path: string, expectation: string): never {
  throw new ConfigError(`Invalid config: "${path}" ${expectation}`)
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string')
  }
  return value
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array of strings')
  }
  return value.map((item, index) => requireString(item, `${path}[${index}]`))
}

/**
 * Validate a positive integer.
 *
 * @param min Smallest accepted value; used to reject zero or negative limits
 */
function requireInteger(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(path, `must be an integer >= ${min}`)
  }
  return value
}

/**
 * Validate an untrusted parsed config object and return it as a typed `Config`.
 *
 * The HTTP security surface — CORS, trusted proxies, the administrative key,
 * rate limits, and the upload limits — is validated by `validateSecurityConfig`
 * so that this module does not duplicate those rules. Everything else, the
 * fields the IPFS node and its cron jobs read, is validated here.
 *
 * Unknown keys are ignored so that config files can carry deployment-specific
 * extras without breaking startup.
 *
 * @param raw Value parsed from a JSON5 config file
 */
export function validateConfig(raw: unknown): Config {
  const root = requireObject(raw, 'config')

  if (!Array.isArray(root.nodes)) {
    fail('nodes', 'must be an array')
  }
  const nodes = root.nodes.map((node, index) => {
    const entry = requireObject(node, `nodes[${index}]`)
    return {
      name: requireString(entry.name, `nodes[${index}].name`),
      multiAddr: requireString(entry.multiAddr, `nodes[${index}].multiAddr`)
    }
  })

  const logLevel = requireString(root.logLevel, 'logLevel')
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    fail('logLevel', `must be one of: ${LOG_LEVELS.join(', ')}`)
  }

  const peerDiscovery = requireObject(root.peerDiscovery, 'peerDiscovery')
  const listen = requireStringArray(peerDiscovery.listen, 'peerDiscovery.listen')
  if (listen.length === 0) {
    fail('peerDiscovery.listen', 'must contain at least one multiaddr')
  }

  const storeFolder = requireString(root.storeFolder, 'storeFolder')
  const serverPort = requireInteger(root.serverPort, 'serverPort', 1)
  const diskUsageScanPeriod = requireString(root.diskUsageScanPeriod, 'diskUsageScanPeriod')
  const peeringSchedule =
    root.peeringSchedule === undefined
      ? DEFAULT_PEERING_SCHEDULE
      : requireString(root.peeringSchedule, 'peeringSchedule')
  const findFileTimeout = requireInteger(root.findFileTimeout, 'findFileTimeout', 1)
  const bootstrap = requireStringArray(peerDiscovery.bootstrap, 'peerDiscovery.bootstrap')

  // Owns cors, trustProxy, adminApiKey, enableDebugApi, rateLimits,
  // uploadLimitSizeBytes and maxFileCount. Throws with its own message.
  validateSecurityConfig(root)

  const cors = requireObject(root.cors, 'cors')

  // Owns the storage lifecycle and replication policy. Both sections are
  // optional: every option falls back to a documented default so that config
  // files written before this feature keep working.
  const storage = resolveStorageConfig(root.storage, root.uploadLimitSizeBytes as number)
  const replication = resolveReplicationConfig(root.replication)

  return {
    nodes,
    storeFolder,
    logLevel: logLevel as LogLevel,
    peerDiscovery: { bootstrap, listen },
    serverPort,
    diskUsageScanPeriod,
    peeringSchedule,
    uploadLimitSizeBytes: root.uploadLimitSizeBytes as number,
    maxFileCount: root.maxFileCount as number,
    findFileTimeout,
    cors: { allowedOrigins: cors.allowedOrigins as string[] },
    trustProxy: (root.trustProxy ?? false) as TrustProxySetting,
    rateLimits: root.rateLimits as Config['rateLimits'],
    adminApiKey: (root.adminApiKey ?? '') as string,
    enableDebugApi: root.enableDebugApi === true,
    storage,
    replication
  }
}

/**
 * Read and validate a config file from the repository root.
 *
 * @param fileName Config file name, see {@link configFileName}
 */
export function loadConfig(fileName: string): Config {
  const configPath = join(rootDir, fileName)

  let contents: string
  try {
    contents = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${configPath}: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON5.parse(contents)
  } catch (err) {
    throw new ConfigError(`Cannot parse config file ${configPath}: ${(err as Error).message}`)
  }

  return validateConfig(parsed)
}

/**
 * Config file used by the running node.
 *
 * The name comes from `IPFS_NODE_CONFIG` when set, otherwise from the first CLI
 * argument as documented in `README.md`. The environment variable takes
 * priority so that the config can be selected when the process is started by a
 * tool that owns the argument list, such as the test runner.
 */
export const CONFIG_FILE_NAME = configFileName(process.env.IPFS_NODE_CONFIG ?? process.argv[2])

export const config = loadConfig(CONFIG_FILE_NAME)

export const packageJson = JSON.parse(
  fs.readFileSync(join(rootDir, 'package.json'), 'utf8')
) as Record<string, unknown> & { version: string }
