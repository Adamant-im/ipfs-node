import express from 'express'
import { httpLogger, logger } from './utils/logger.js'
import { config, CONFIG_FILE_NAME } from './config.js'
import { diskUsageCron } from './disk-usage.cron.js'
import { garbageCollectionCron } from './gc.cron.js'
import { replicationRepairCron } from './replication.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { mountApiRoutes } from './security/accessPolicy.js'
import { createApiKeyAuth } from './security/apiKey.js'
import { createReplicationAuth } from './security/replicationToken.js'
import { createCorsOriginDelegate } from './security/cors.js'
import { parseTrustProxy } from './security/trustProxy.js'

logger.info(`Using config file: ${CONFIG_FILE_NAME}`)

diskUsageCron.start()

// Deletion is opt-in: the collector only runs once an operator has agreed to a
// deletion policy and enabled it. Until then the authorized
// POST /api/storage/gc endpoint stays the only way to reclaim space.
if (config.storage.gc.enabled) {
  logger.info(
    `Garbage collection enabled: high watermark ${config.storage.gc.highWatermarkBytes} bytes, ` +
      `low watermark ${config.storage.gc.lowWatermarkBytes} bytes`
  )
  garbageCollectionCron.start()
} else {
  logger.info('Garbage collection is disabled. Storage grows until an operator collects it.')
}

if (config.replication.enabled) {
  if (config.replication.repairEnabled) {
    replicationRepairCron.start()
  }
} else {
  logger.info('Replication is disabled. Uploaded content is stored best effort on this node.')
}

const PORT = config.serverPort
const app = express()
app.disable('x-powered-by')
const trustProxy = parseTrustProxy(config.trustProxy)
app.set('trust proxy', trustProxy)

if (trustProxy === false) {
  logger.warn(
    'trustProxy is false. If requests arrive through a reverse proxy, all clients will share ' +
      'the proxy IP for rate limiting until exact trusted proxy addresses are configured.'
  )
}

app.use(httpLogger)

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

mountApiRoutes(
  app,
  routers,
  createApiKeyAuth(config.adminApiKey),
  config.enableDebugApi === true,
  // The token alone opens replication intake. `replication.enabled` governs
  // whether this node pushes copies out, which a receive-only node never does.
  createReplicationAuth(config.replication.token)
)

app.use(notFoundHandler)
app.use(errorHandler)

app.listen(PORT, () => {
  logger.info(`Server is running on http://localhost:${PORT}`)
  logger.warn(
    'TLS is not handled at the application level. ' +
      'Ensure this service is deployed behind a TLS-terminating reverse proxy (e.g. nginx, Caddy).'
  )
})
