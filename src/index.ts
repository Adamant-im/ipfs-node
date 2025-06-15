import express from 'express'
import swaggerUi from 'swagger-ui-express'
import { swaggerSpec } from './swagger.js'
import { Request, Response } from 'express'
import { httpLogger, logger } from './utils/logger.js'
import { config, CONFIG_FILE_NAME } from './config.js'
import { diskUsageCron } from './disk-usage.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'
import { datastore, blockstore } from './store.js'

await datastore.open()
await blockstore.open()

logger.info(`Using config file: ${CONFIG_FILE_NAME}`)

diskUsageCron.start()

const PORT = config.serverPort
const app = express()

app.use(httpLogger)

app.use(
  cors({
    origin: config.cors.origin,
    credentials: config.cors.credentials,
    methods: ['GET', 'POST']
  })
)

app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

app.get('/', (req, res) => {
  res.send('IPFS node')
})

app.use('/api/file', routers.file)
app.use('/api/node', routers.node)
app.use('/api/helia', routers.helia)
app.use('/api/libp2p', routers.libp2p)
app.use('/api/debug', routers.debug)

app.use((err: Error, req: Request, res: Response) => {
  logger.error(`${err.message}\n${err.stack}`)
  res.status(500).send({ error: 'Internal Server Error. See logs.' })
})

app.listen(PORT, () => {
  logger.info(`Server is running on http://localhost:${PORT}`)
})
