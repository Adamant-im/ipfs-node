import express, { NextFunction } from 'express'
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

app.use(pino)

app.use(
  cors({
    origin: config.cors.originRegexps.map((item: string) => new RegExp(`^https?:\\/\\/${item}`)),
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

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  pino.logger.error(`${err.message}\n${err.stack}`)
  res.status(500).send({ error: 'Internal Server Error. See logs.' })
})

app.listen(PORT, () => {
  pino.logger.info(`Server is running on http://localhost:${PORT}`)
})
