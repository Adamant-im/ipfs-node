import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { blockstore, datastore } from './store.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'
import { config } from './config.js'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { FaultTolerance } from '@libp2p/interface-transport'

export const helia = await createHelia({
  datastore,
  blockstore,
  libp2p: {
    peerDiscovery: [
      bootstrap({
        list: config.peerDiscovery.bootstrap
      })
    ],
    addresses: {
      listen: config.peerDiscovery.listen
    },
    connectionManager: {
      /**
       * The total number of connections allowed to be open at one time
       */
      // maxConnections: 10,

      /**
       * If the number of open connections goes below this number, the node
       * will try to connect to randomly selected peers from the peer store
       */
      // minConnections: 5,

      /**
       * How many connections can be open but not yet upgraded
       */
      // maxIncomingPendingConnections: 10,

      /**
       * A list of multiaddrs that will always be allowed (except if they are in the deny list) to open connections to this node even if we've reached maxConnections
       */
      allow: getAllowNodesMultiaddrs()
    },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncryption: [noise()],
    transportManager: {
      faultTolerance: FaultTolerance.NO_FATAL
    }
  }
})
