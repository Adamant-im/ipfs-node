import { pinoHttp } from 'pino-http'

export const pino = pinoHttp({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'dd.mm.yy HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
})
