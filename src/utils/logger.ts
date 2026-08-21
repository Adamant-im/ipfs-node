import { pino } from 'pino'
import { pinoHttp } from 'pino-http'
import { config } from '../config.js'

/**
 * Application logger.
 *
 * `pino-pretty` is loaded as a transport at runtime, so it is a runtime
 * dependency rather than a development one.
 */
export const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'dd.mm.yy HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
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
