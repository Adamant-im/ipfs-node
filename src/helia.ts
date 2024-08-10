import { unixfs } from '@helia/unixfs'
import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { blockstore, datastore } from './store.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'
import { config } from './config.js'
import { pino } from './utils/logger.js'

export const helia = await createHelia({
  datastore,
  blockstore,
  libp2p: {
    datastore,
    addresses: {
      listen: config.peerDiscovery.listen
    },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: config.peerDiscovery.bootstrap
      })
    ],
    services: {
      identify: identify()
    },
    connectionManager: {
      maxConnections: 100,
      allow: getAllowNodesMultiaddrs()
    }
  }
})

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

export const ifs = unixfs(helia)
