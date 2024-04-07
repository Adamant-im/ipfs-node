import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { kadDHT, removePrivateAddressesMapper } from "@libp2p/kad-dht";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { createFromJSON } from "@libp2p/peer-id-factory";
import { datastore } from "./store.js";
import config from "./config.js";

/* const peerId = await createFromJSON(config.peer);
console.log("PeerID:", peerId.toString()); */

export const libp2p_old = await createLibp2p({
  peerId,
  datastore,
  addresses: {
    listen: [
      // "/ip4/127.0.0.1/tcp/4001",
      "/ip4/0.0.0.0/tcp/4001",
    ],
  },
  transports: [tcp()],
  connectionEncryption: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [
    bootstrap({
      list: [
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
      ],
    }),
  ],
  services: {
    identify: identify(),
    dht: kadDHT({}),
  },
});

export const libp2p = await createLibp2p({
  addresses: {
    listen: ["/ip4/127.0.0.1/tcp/4001", "/ip4/0.0.0.0/tcp/4001"],
  },
  transports: [tcp()],
  services: {
    aminoDHT: kadDHT({
      protocol: "/ipfs/kad/1.0.0",
      peerInfoMapper: removePrivateAddressesMapper,
    }),
  },
});
