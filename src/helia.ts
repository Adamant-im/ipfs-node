import { bootstrap } from '@libp2p/bootstrap'
import { createHelia } from 'helia'
import { createLibp2p } from 'libp2p'
import { blockstore, datastore } from './store.js'
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
  datastore,
  blockstore,
  libp2p: {
    datastore,
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/4001']
    },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: [
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
        ]
      })
    ],
    services: {
      identify: identify()
    }
  }
})
