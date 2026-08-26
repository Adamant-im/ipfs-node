import express from 'express'
import { httpLogger, logger } from './utils/logger.js'
import { config, CONFIG_FILE_NAME } from './config.js'
import { diskUsageCron } from './disk-usage.cron.js'
import { peeringCron, peerWithKnownNodes } from './peering.cron.js'
import { helia, ifs } from './helia.js'
import { backfillRegistryFromPins, snapshotPins } from './storage/backfill.js'
import { recoverInterruptedAdmissions } from './storage/admission.js'
import { registerReplicationProtocol } from './storage/replicationProtocol.js'
import { createReplicationHandlers } from './storage/service.js'
import { fileRegistry } from './storage/state.js'
import { garbageCollectionCron } from './gc.cron.js'
import { replicationRepairCron } from './replication.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { mountApiRoutes } from './security/accessPolicy.js'
import { createApiKeyAuth } from './security/apiKey.js'
import { createCorsOriginDelegate } from './security/cors.js'
import { parseTrustProxy } from './security/trustProxy.js'

logger.info(`Using config file: ${CONFIG_FILE_NAME}`)

diskUsageCron.start()

// Bootstrap dials the peers once and never again, so the mesh is kept together
// here instead. Retrieval and replication both depend on it being intact.
peeringCron.start()
await peerWithKnownNodes()

// Which pins are legacy is decided here, before this node accepts new pins
// over the replication protocol or the upload API. A replica staged after
// this snapshot is a request with a lifecycle of its own; if the backfill
// saw it after an abort, it would record the leftover pin as confirmed.
const legacyPins = await snapshotPins(helia)

// Answering the protocol is what lets peers place copies here, and it is
// registered whether or not this node places copies of its own. A node that
// only accepted copies when it was also sending them could not be added to a
// network without every other node being reconfigured first.
await registerReplicationProtocol(helia, createReplicationHandlers(), {
  requestTimeoutMs: config.replication.requestTimeoutMs
})

/** The scheduled work that reads the file registry and acts on what it finds. */
function startLifecycleJobs(): void {
  // The collector frees blocks only when space is short: above the high
  // watermark or once free space falls into the disk reserve. It never selects
  // a confirmed file this node holds, so leaving it on frees nothing while
  // there is room.
  if (config.storage.gc.enabled) {
    logger.info(
      `Garbage collection enabled: frees blocks above ${config.storage.gc.highWatermarkBytes} ` +
        `bytes of blockstore, or when free space falls into the ` +
        `${config.storage.diskReserveBytes} byte reserve`
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
}

// Content pinned before this release has no registry entry, which would leave
// it out of the storage report, out of dry runs, and out of replication repair.
// Recording it is idempotent. Listing is cheap; reconciling is not, which is
// why only the snapshot is ordered against protocol registration and the listener.

// The reconciliation is deliberately not awaited. It is as long as the pinset,
// and blocking here would keep the whole API — reads included — unavailable for
// the entire migration on exactly the nodes that have the most to serve. Reads,
// uploads and incoming copies do not need the registry to be complete; the jobs
// that do are started once it is.
void Promise.all([
  backfillRegistryFromPins({
    cids: legacyPins,
    unixfs: ifs,
    registry: fileRegistry,
    confirmationRequired: config.storage.confirmationRequired,
    temporaryTtlMs: config.storage.temporaryTtlMs,
    log: (message) => logger.info(message)
  }),
  recoverInterruptedAdmissions(fileRegistry)
])
  .then(([backfill, admissions]) => {
    for (const error of backfill.errors) {
      logger.warn(`Registry backfill: ${error}`)
    }
    for (const error of admissions.errors) {
      logger.warn(`Admission recovery: ${error}`)
    }
    if (admissions.recovered > 0) {
      logger.info(`Admission recovery: cleared ${admissions.recovered} interrupted uploads`)
    }
  })
  .catch((err: Error) => logger.error(`Startup storage reconciliation failed: ${err.message}`))
  // Even a failed reconciliation must not leave the node without a collector:
  // it reclaims nothing that is unregistered, so an incomplete registry makes
  // it do less, never more.
  .finally(startLifecycleJobs)

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

mountApiRoutes(app, routers, createApiKeyAuth(config.adminApiKey), config.enableDebugApi === true)

app.use(notFoundHandler)
app.use(errorHandler)

const server = app.listen(PORT, () => {
  logger.info(`Server is running on http://localhost:${PORT}`)
  logger.warn(
    'TLS is not handled at the application level. ' +
      'Ensure this service is deployed behind a TLS-terminating reverse proxy (e.g. nginx, Caddy).'
  )
})

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down`)
  diskUsageCron.stop()
  peeringCron.stop()
  garbageCollectionCron.stop()
  replicationRepairCron.stop()
  server.close(() => {
    void helia.stop().finally(() => process.exit(0))
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
