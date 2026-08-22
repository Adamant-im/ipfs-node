import { Multiaddr } from '@multiformats/multiaddr'
import { PeerId } from '@libp2p/interface'
import { CID, Version } from 'multiformats/cid'

export type NodeWithPeerId = {
  name: string
  multiAddr: Multiaddr
  peerId: PeerId
  /** Base URL of the node REST API; only replication peers need one. */
  apiUrl?: string
}

export type ConfigNode = {
  name: string
  multiAddr: string
  apiUrl?: string
}

export type UnixFsMulterFile = Express.Multer.File & {
  cid: CID<unknown, number, number, Version>
  /** Bytes of blocks this node wrote while importing the part. */
  storedBytes: number
}
