import { unixfs } from '@helia/unixfs'
import { createVerifiedFetch } from '@helia/verified-fetch'
import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { blockstore, datastore } from './store.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'
import { config } from './config.js'
import { ConfigNode } from './utils/types.js'

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

export const ifs = unixfs(helia)

export const verifiedFetch = await createVerifiedFetch(helia)
