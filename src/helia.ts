import { identify } from '@libp2p/identify';
import { createHelia } from "helia";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { MemoryDatastore } from "datastore-core";
import { MemoryBlockstore } from "blockstore-core";
import { unixfs } from "@helia/unixfs";
import last from "it-last";

const blockstore = new MemoryBlockstore();
const datastore = new MemoryDatastore();

const libp2p = await createLibp2p({
  addresses: {
    listen: ["/ip4/0.0.0.0/tcp/0"],
  },
  transports: [tcp()],
  connectionEncryption: [noise()],
  streamMuxers: [yamux()],
  datastore,
    services: {
      identify: identify(),
    }
});

const helia = await createHelia({
  datastore,
  blockstore,
  libp2p,
});
