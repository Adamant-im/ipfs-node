import express from 'express'
import { pino } from './utils/logger.js'
import { config, CONFIG_FILE_NAME } from './config.js'
import { diskUsageCron } from './disk-usage.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { mountApiRoutes } from './security/accessPolicy.js'
import { createApiKeyAuth } from './security/apiKey.js'
import { createCorsOriginDelegate } from './security/cors.js'
import { parseTrustProxy } from './security/trustProxy.js'

pino.logger.info(`Using config file: ${CONFIG_FILE_NAME}`)

diskUsageCron.start()

const PORT = config.serverPort
const app = express()
app.disable('x-powered-by')
const trustProxy = parseTrustProxy(config.trustProxy)
app.set('trust proxy', trustProxy)

if (trustProxy === false) {
  pino.logger.warn(
    'trustProxy is false. If requests arrive through a reverse proxy, all clients will share ' +
      'the proxy IP for rate limiting until exact trusted proxy addresses are configured.'
  )
}

app.use(pino)

app.use(
  cors({
    origin: createCorsOriginDelegate(config.cors.allowedOrigins),
    credentials: false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-api-key'],
    maxAge: 600
  })
)

app.get('/', (req, res) => {
  res.send('IPFS node')
})

mountApiRoutes(app, routers, createApiKeyAuth(config.adminApiKey), config.enableDebugApi === true)

app.use(notFoundHandler)
app.use(errorHandler)

app.listen(PORT, () => {
  pino.logger.info(`Server is running on http://localhost:${PORT}`)
  pino.logger.warn(
    'TLS is not handled at the application level. ' +
      'Ensure this service is deployed behind a TLS-terminating reverse proxy (e.g. nginx, Caddy).'
  )
})
