import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { blockstore, heliaDatastore, libp2pDatastore } from './store.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'
import { config } from './config.js'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { FaultTolerance } from '@libp2p/interface-transport'
import { mplex } from '@libp2p/mplex'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { SignaturePolicy } from '@chainsafe/libp2p-gossipsub/types'
import { kadDHT } from '@libp2p/kad-dht'
import { webRTC } from '@libp2p/webrtc'

export const helia = await createHelia({
  datastore: heliaDatastore,
  blockstore,
  libp2p: {
    datastore: libp2pDatastore,
    // peerDiscovery: [
    //   bootstrap({
    //     list: config.peerDiscovery.bootstrap
    //   })
    // ],
    addresses: {
      listen: config.peerDiscovery.listen
    },
    connectionManager: {
      /**
       * The total number of connections allowed to be open at one time
       */
      maxConnections: 10,

      /**
       * If the number of open connections goes below this number, the node
       * will try to connect to randomly selected peers from the peer store
       */
      minConnections: 0,

      /**
       * How many connections can be open but not yet upgraded
       */
      // maxIncomingPendingConnections: 10,

      /**
       * A list of multiaddrs that will always be allowed (except if they are in the deny list) to open connections to this node even if we've reached maxConnections
       */
      allow: getAllowNodesMultiaddrs(),

      maxParallelDials: 3
    },
    // transports: [tcp(), webRTC()],
    streamMuxers: [yamux()],
    connectionEncryption: [noise()]
  }
})
