import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import config from '../config'
import { NodeWithPeerId } from './types'

/**
 * Get peerId from multiaddr string
 * @param multiAddr E.g. "/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWBiqmfA32nZ2KGa8tsqigVpdY9oJB7GfrXvfgySDajpiZ"
 * @return Return instance of PeerId, e.g. "PeerId(12D3KooWBiqmfA32nZ2KGa8tsqigVpdY9oJB7GfrXvfgySDajpiZ)"
 */
export function peerIdFromMultiaddr(multiAddr: string) {
  const addrParts = multiAddr.split('/')
  let addr
  //  parse multiAddr like this: "/ip4/38.143.66.227/tcp/4001/p2p/12D3KooWCqayYQ5B8bF6NAaDgbZRcE9eyQFEdSYGjoSadBt1oTVT/p2p-circuit"
  addrParts.forEach((part, index) => {
    if (part === 'p2p') {
      addr = addrParts[index + 1] ? addrParts[index + 1] : addr
    }
  })
  if (!addr) {
    throw new Error('Invalid multiAddr')
  }
  return peerIdFromString(addr)
}

export function parseNodes(): NodeWithPeerId[] {
  return config.nodes.map((node) => ({
    name: node.name,
    multiAddr: multiaddr(node.multiAddr),
    peerId: peerIdFromMultiaddr(node.multiAddr)
  }))
}

/**
 * Get a list of own IPFS nodes from the config file
 */
export function getNodesList(excludedPeerIds: string[] = []) {
  return parseNodes().filter((node) => !excludedPeerIds.includes(node.peerId.toString()))
}

/**
 * Get node name by `multiAddr`
 */
export function getNodeName(multiAddr: string) {
  return parseNodes().find((node) => node.multiAddr.toString() === multiAddr.toString())?.name
}

export function getAllowNodesMultiaddrs() {
  return parseNodes().map((node) => node.multiAddr.toString())
}

export function flatFiles(
  files: { [fieldname: string]: Express.Multer.File[] } | Express.Multer.File[]
) {
  let resultFiles: Express.Multer.File[] = []
  if (Array.isArray(files)) {
    return files
  } else {
    for (const filename in files) {
      if (Object.prototype.hasOwnProperty.call(files, filename)) {
        resultFiles = [...resultFiles, ...files[filename]]
      }
    }
    return resultFiles
  }
}
