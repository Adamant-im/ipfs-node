import { Multiaddr } from '@multiformats/multiaddr'
import { PeerId } from '@libp2p/interface'

export type NodeWithPeerId = {
  name: string
  multiAddr: Multiaddr
  peerId: PeerId
}
