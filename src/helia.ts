import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { blockstore, datastore } from './store.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'

export const helia = await createHelia({
  datastore,
  blockstore,
  libp2p: {
    peerDiscovery: [
      bootstrap({
        list: [
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
          '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
          '/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ'
        ]
      })
    ],
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/4001', '/ip6/::/tcp/4002', '/webrtc']
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
    }
  }
})
