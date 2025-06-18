import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { unixfs } from '@helia/unixfs'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { tcp } from '@libp2p/tcp'
import { createHelia } from 'helia'

import { config } from './config.js'
import { blockstore, datastore } from './store.js'
import { logger } from './utils/logger.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'

const allowedNodes = getAllowNodesMultiaddrs()

export const helia = await createHelia({
  datastore,
  blockstore,
  libp2p: {
    datastore,
    addresses: {
      listen: config.peerDiscovery.listen
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: config.peerDiscovery.bootstrap
      })
    ],
    services: {
      identify: identify(),
      ping: ping()
    },
    connectionManager: {
      maxConnections: allowedNodes.length,
      allow: allowedNodes
    }
  }
})

helia.libp2p.getMultiaddrs().forEach((addr) => {
  logger.info(`Listening on ${addr.toString()}`)
})

helia.libp2p.addEventListener('peer:discovery', (evt) => {
  const peer = evt.detail
  logger.info(`Discovered peer: ${peer.id}`)
})

helia.libp2p.addEventListener('peer:connect', (evt) => {
  const peerId = evt.detail
  logger.info(`Peer connected: ${peerId}`)
})

helia.libp2p.addEventListener('peer:disconnect', (evt) => {
  const peerId = evt.detail
  logger.info(`Peer disconnected: ${peerId}`)
})

helia.libp2p.addEventListener('start', () => {
  logger.info('Libp2p node started')
})

helia.libp2p.addEventListener('stop', () => {
  logger.info('Libp2p node stopped')
})

logger.info(`Helia is running! PeerID: ${helia.libp2p.peerId.toString()}`)

export const ifs = unixfs(helia)
