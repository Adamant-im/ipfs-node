import { Multiaddr } from '@multiformats/multiaddr'
import { PeerId } from '@libp2p/interface'
import { CID, Version } from 'multiformats/cid'

export type NodeWithPeerId = {
  name: string
  multiAddr: Multiaddr
  peerId: PeerId
}

export type ConfigNode = {
  name: string
  multiAddr: string
}

export type UnixFsMulterFile = Express.Multer.File & { cid: CID<unknown, number, number, Version> }
