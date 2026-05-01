import express from 'express'
import { Request, Response } from 'express'
import { pino } from './utils/logger.js'
import { config, CONFIG_FILE_NAME } from './config.js'
import { diskUsageCron } from './disk-usage.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'

pino.logger.info(`Using config file: ${CONFIG_FILE_NAME}`)

diskUsageCron.start()

const PORT = config.serverPort
const app = express()
app.disable('x-powered-by')

app.use(pino)

const allowedOrigins: RegExp[] = (config.cors?.originRegexps ?? []).map(
  (pattern: string) => new RegExp(pattern)
)

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  })
)

app.get('/', (req, res) => {
  res.send('IPFS node')
})

app.use('/api/file', routers.file)
app.use('/api/node', routers.node)
app.use('/api/helia', routers.helia)
app.use('/api/libp2p', routers.libp2p)
app.use('/api/debug', routers.debug)

app.use((err: Error, req: Request, res: Response) => {
  pino.logger.error(`${err.message}\n${err.stack}`)
  res.status(500).send({ error: 'Internal Server Error' })
})

app.listen(PORT, () => {
  pino.logger.info(`Server is running on http://localhost:${PORT}`)
  pino.logger.warn(
    'TLS is not handled at the application level. ' +
      'Ensure this service is deployed behind a TLS-terminating reverse proxy (e.g. nginx, Caddy).'
  )
})
