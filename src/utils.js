import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import config from "./config.js";

/**
 * Get peerId from multiaddr string
 * @param multiaddr E.g. "/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWBiqmfA32nZ2KGa8tsqigVpdY9oJB7GfrXvfgySDajpiZ"
 * @return Return instance of PeerId, e.g. "PeerId(12D3KooWBiqmfA32nZ2KGa8tsqigVpdY9oJB7GfrXvfgySDajpiZ)"
 */
export function peerIdFromMultiaddr(multiaddr) {
  // @todo parse multiaddrs like this:
  // "/ip4/38.143.66.227/tcp/4001/p2p/12D3KooWCqayYQ5B8bF6NAaDgbZRcE9eyQFEdSYGjoSadBt1oTVT/p2p-circuit"
  return peerIdFromString(multiaddr.split("/").pop());
}

export function parseNodes() {
  return config.nodes.map((node) => ({
    name: node.name,
    multiaddr: multiaddr(node.multiaddr),
    peerId: peerIdFromMultiaddr(node.multiaddr),
  }));
}

/**
 * Get a list of own IPFS nodes from the config file
 */
export function getNodesList(excludedPeerIds = []) {
  return parseNodes().filter(
    (node) => !excludedPeerIds.includes(node.peerId.toString())
  );
}

/**
 * Get node name by `multiaddr`
 */
export function getNodeName(multiaddr) {
  return parseNodes().find(
    (node) => node.multiaddr.toString() === multiaddr.toString(),
  )?.name;
}

export function getAllowNodesMultiaddrs() {
  return parseNodes().map((node) => node.multiaddr.toString());
}
