import { pinoHttp } from 'pino-http'
import config from '../config.js'

export const pino = pinoHttp({
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
