import { CID } from 'multiformats/cid'
import { pino } from 'pino'
import type { DestinationStream, LogFn, Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import { config } from '../config.js'

/**
 * Path segments that belong to the API surface rather than to a request.
 *
 * Every variable segment of this API is a CID, so anything outside this set is
 * replaced before a request is logged. A CID identifies stored user content and
 * has no place in output a collector retains.
 */
const ROUTE_SEGMENTS = new Set([
  'api',
  'file',
  'node',
  'storage',
  'helia',
  'libp2p',
  'debug',
  'upload',
  'status',
  'confirm',
  'unpin',
  'health',
  'info',
  'details',
  'metrics',
  'policy',
  'gc',
  'repair',
  'autopeering',
  'peers',
  'pin',
  'pins',
  'isPinned'
])

/**
 * Reduce a request target to its route shape.
 *
 * Drops the query string and masks every segment that is not part of a known
 * route, so `/api/file/bafy.../status` is logged as `/api/file/:param/status`.
 *
 * @param url raw request target
 * @returns route shape carrying no user-supplied value
 */
export function routeShape(url: string | undefined): string {
  if (url === undefined || url === '') {
    return '/'
  }

  const path = url.split('?')[0]
  const shape = path
    .split('/')
    .map((segment) => (segment === '' || ROUTE_SEGMENTS.has(segment) ? segment : ':param'))
    .join('/')

  return shape === '' ? '/' : shape
}

/**
 * Values that must never appear in output a collector retains.
 *
 * Multiaddrs are matched first because one embeds a peer id, and the stack
 * pattern last because it is the only multi-line rule. Each entry is anchored
 * on a shape that cannot occur in prose, so an operational message keeps its
 * meaning while the identifier inside it does not survive.
 */
const LOG_SCRUBBERS: Array<[RegExp, string]> = [
  [/\/(?:ip4|ip6|dns|dns4|dns6|dnsaddr)\/[^\s"',)]+/g, '[multiaddr]'],
  [/\b12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}\b/g, '[peer]'],
  [/\n\s+at\s+[\s\S]*$/, ' [stack omitted]']
]

/**
 * Tokens shaped like an encoded CID, by multibase prefix.
 *
 * The bounds are the shortest a CID can be, not a guess at what looks like one:
 * an identity multihash over empty bytes encodes to `bafkqaaa`, eight
 * characters. Ordinary words are inside these bounds too, which is why the
 * decision belongs to the parser below rather than to the shape — the shape only
 * has to be cheap enough that most prose never reaches it.
 */
const CID_CANDIDATE =
  /\b(?:b[a-z2-7]{6,}|B[A-Z2-7]{6,}|z[1-9A-HJ-NP-Za-km-z]{6,}|f[0-9a-f]{7,}|Qm[1-9A-HJ-NP-Za-km-z]{44})\b/g

/** Replace every token the CID parser accepts, whatever its version or encoding. */
function scrubCids(value: string): string {
  return value.replace(CID_CANDIDATE, (token) => {
    try {
      CID.parse(token)
      return '[cid]'
    } catch {
      return token
    }
  })
}

/**
 * Remove content identifiers, peer identities, and stack traces from a message.
 *
 * The HTTP serializers cannot reach these: they sanitize request and response
 * objects, while most application logging is a template string built at the
 * call site. Scrubbing centrally means a call site added later cannot reopen
 * the hole, which a per-site convention would not guarantee.
 *
 * @param value message or string field about to be logged
 * @returns the same text with every identifier replaced by a fixed placeholder
 */
export function scrubLogValue(value: string): string {
  const scrubbed = LOG_SCRUBBERS.reduce((text, [pattern, placeholder]) => {
    // A global regex carries `lastIndex` between calls; reset before reuse.
    pattern.lastIndex = 0
    return text.replace(pattern, placeholder)
  }, value)

  CID_CANDIDATE.lastIndex = 0
  return scrubCids(scrubbed)
}

/** Apply {@link scrubLogValue} through the strings of one log argument. */
function scrubLogArgument(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return scrubLogValue(value)
  }

  // `logger.error(err)` takes the message straight from the error for `msg`,
  // before any serializer runs, so the error is replaced by a scrubbed copy
  // rather than passed through. The `err` serializer then drops the stack.
  if (value instanceof Error) {
    const scrubbed: Error & { code?: unknown } = new Error(scrubLogValue(value.message))
    scrubbed.name = value.name
    const { code } = value as Error & { code?: unknown }
    if (code !== undefined) {
      scrubbed.code = code
    }
    return scrubbed
  }

  if (value === null || typeof value !== 'object' || depth > 4) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubLogArgument(item, depth + 1))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubLogArgument(item, depth + 1)])
  )
}

/**
 * Application logger.
 *
 * Production output is newline-delimited JSON. Pretty output is opt-in because
 * formatting destroys fields that log collectors use for querying and alerts.
 *
 * Three controls keep content and topology out of the output: `hooks.logMethod`
 * scrubs every message and structured field, the `err` serializer reports an
 * error without its stack, and `redact` covers call sites that log a request or
 * response object directly.
 */
export function createApplicationLogger(
  options: { level?: string; destination?: DestinationStream } = {}
): Logger {
  const level = options.level ?? config.logLevel
  const shared = {
    level,
    hooks: {
      logMethod(this: Logger, args: unknown[], method: LogFn): void {
        method.apply(this, args.map((argument) => scrubLogArgument(argument)) as Parameters<LogFn>)
      }
    },
    serializers: {
      err: (err: Error & { code?: unknown }) => ({
        type: err.name,
        message: scrubLogValue(err.message),
        ...(typeof err.code === 'string' ? { code: err.code } : {})
      })
    },
    redact: {
      paths: [
        'req.headers["x-api-key"]',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]'
      ],
      censor: '[redacted]'
    }
  }

  // A caller-supplied destination is how the sanitizing wiring is exercised; a
  // transport would send the records to another thread instead.
  if (options.destination !== undefined) {
    return pino(shared, options.destination)
  }

  return pino({
    ...shared,
    transport: config.prettyLogs
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'dd.mm.yy HH:MM:ss Z',
            ignore: 'pid,hostname'
          }
        }
      : undefined
  })
}

export const logger = createApplicationLogger()

/**
 * Express middleware that logs requests through {@link logger}.
 *
 * Request logs are emitted at `debug` level to keep them out of the default
 * `info` output while still sharing the application logger's transport.
 *
 * The default serializers copy every request header and the raw target, which
 * writes the administrative `x-api-key` verbatim and puts the served CID in the
 * log — including through the `ETag` and `Content-Disposition` response headers.
 * Only the method, the route shape, and the status are recorded instead, so the
 * log level is not the only thing standing between a request and a secret.
 */
export const httpLogSerializers = {
  req: (req: { method?: string; url?: string }) => ({
    method: req.method,
    url: routeShape(req.url)
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode })
}

export const httpLogger = pinoHttp({
  logger,
  useLevel: 'debug',
  serializers: httpLogSerializers
})
