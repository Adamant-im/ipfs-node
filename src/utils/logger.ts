import { pino } from 'pino'
import { pinoHttp } from 'pino-http'
import { config } from '../config.js'

/**
 * Application logger.
 *
 * Production output is newline-delimited JSON. Pretty output is opt-in because
 * formatting destroys fields that log collectors use for querying and alerts.
 */
export const logger = pino({
  level: config.logLevel,
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
 */
export const httpLogger = pinoHttp({
  logger,
  useLevel: 'debug'
})
