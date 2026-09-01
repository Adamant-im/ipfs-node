import { pino } from 'pino'
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
 * Application logger.
 *
 * Production output is newline-delimited JSON. Pretty output is opt-in because
 * formatting destroys fields that log collectors use for querying and alerts.
 *
 * `redact` is a second line of defense for call sites that log a request or
 * response object directly; the HTTP serializers below already drop headers.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]'
    ],
    censor: '[redacted]'
  },
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
