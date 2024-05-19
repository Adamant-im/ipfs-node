import express, { NextFunction } from 'express'
import { helia } from './helia.js'
import { Request, Response } from 'express'
import { createVerifiedFetch } from '@helia/verified-fetch'
import { pino } from './utils/logger.js'
import { config, configFileName, packageJson } from './config.js'
import { getDiskUsageStats, diskUsageCron } from './disk-usage.cron.js'
import cors from 'cors'
import * as routers from './api/index.js'

pino.logger.info(`Using config file: ${configFileName}`)

const verifiedFetch = await createVerifiedFetch(helia)

helia.libp2p.getMultiaddrs().forEach((addr) => {
  pino.logger.info(`Listening on ${addr.toString()}`)
})

helia.libp2p.addEventListener('peer:discovery', (evt) => {
  const peer = evt.detail
  pino.logger.info(`Discovered peer: ${peer.id}`)
})

helia.libp2p.addEventListener('peer:connect', (evt) => {
  const peerId = evt.detail
  pino.logger.info(`Peer connected: ${peerId}`)
})

helia.libp2p.addEventListener('peer:disconnect', (evt) => {
  const peerId = evt.detail
  pino.logger.info(`Peer disconnected: ${peerId}`)
})

helia.libp2p.addEventListener('start', (event) => {
  pino.logger.info('Libp2p node started')
})

helia.libp2p.addEventListener('stop', (event) => {
  pino.logger.info('Libp2p node stopped')
})

pino.logger.info(`Helia is running! PeerID: ${helia.libp2p.peerId.toString()}`)

// autoPeering.start()
// autoPeeringHandler().catch((err) => pino.logger.error(`${err.message}\n${err.stack}`))
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

app.use('/api', routers.file)
app.use('/api', routers.node)
app.use('/api', routers.helia)
app.use('/api', routers.libp2p)
app.use('/api', routers.debug)

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  pino.logger.error(`${err.message}\n${err.stack}`)
  res.status(500).send({ error: 'Internal Server Error. See logs.' })
})

app.listen(PORT, () => {
  pino.logger.info(`Server is running on http://localhost:${PORT}`)
})
