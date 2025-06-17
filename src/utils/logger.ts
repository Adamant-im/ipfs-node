import { pino } from 'pino'
import { pinoHttp } from 'pino-http'

import { config } from '../config.js'

export const logger = pino({
  level: config.logLevel || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'dd.mm.yy HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
})

export const httpLogger = pinoHttp({
  level: config.logLevel || 'info',
  useLevel: 'debug',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'dd.mm.yy HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
})
