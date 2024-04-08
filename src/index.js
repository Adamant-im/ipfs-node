import { unixfs } from "@helia/unixfs";
import { peerIdFromString } from "@libp2p/peer-id";
import { CID } from "multiformats/cid";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "url";
import multer from "multer";
import { multiaddr } from "@multiformats/multiaddr";
import { autoPeeringHandler } from "./cron.js";
import { helia } from "./helia.js";

const storage = multer.memoryStorage();
const upload = multer({ storage });

// console.log("Created Helia instance");
// await helia.libp2p.services.dht.setMode("server");
// console.log("Switched DHT to server mode");

helia.libp2p.getMultiaddrs().forEach((addr) => {
  console.log(`Listening on ${addr.toString()}`);

  // @todo
  // cron.autoPeering.start()
});

helia.libp2p.addEventListener("peer:discovery", (evt) => {
  const peer = evt.detail;
  if (logNewPeers) {
    console.log("Discovered peer:", peer.id);
  }
});

let logNewPeers = false;

helia.libp2p.addEventListener("peer:connect", (evt) => {
  const peerId = evt.detail;

  if (logNewPeers) {
    console.log("Peer connected:", peerId);
  }
});

helia.libp2p.addEventListener("peer:disconnect", (evt) => {
  const peerId = evt.detail;

  if (logNewPeers) {
    console.log("Peer disconnected:", peerId);
  }
});

helia.libp2p.addEventListener("start", (event) => {
  console.info("Libp2p node started");
});

helia.libp2p.addEventListener("stop", (event) => {
  console.info("Libp2p node stopped");
});

const ifs = unixfs(helia);

console.info(`Helia is running! PeerID: ${helia.libp2p.peerId.toString()}`);

// const cid = await ifs.addFile({
//   path: "/hello.txt",
//   content: readFileSync("./files/hello.txt"),
// });
//
// console.log("CID", cid);

const PORT = 4000;
const app = express();

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/cron/autopeering", async (req, res) => {
  const successPeers = await autoPeeringHandler();

  res.send({
    peeredSuccessfullyTo: successPeers,
  });
});

app.get("/libp2p/services/ping", async (req, res) => {
  try {
    const peerId = peerIdFromString(req.query.peerId);

    const pong = await helia.libp2p.services.ping.ping(peerId);

    res.send({
      pong,
    });
  } catch (err) {
    res.send({
      error: err.message,
    });
  }
});

app.get("/libp2p/peerStore", async (req, res) => {
  const peerId = req.query.peerId;

  try {
    const peers = await helia.libp2p.peerStore.all({
      filters: [
        (peer) => {
          if (!peerId) {
            return true;
          }

          return peer.id.toString() === peerId;
        },
      ],
      limit: 10,
    });

    res.send({
      length: peers.length,
      peers: peers.map((peer) => {
        return {
          id: peer.id.toString(),
        };
      }),
    });
  } catch (err) {
    res.send({
      error: err.message,
    });
  }
});

app.get("/libp2p/peerInfo", async (req, res) => {
  const peerId = req.query.peerId;

  try {
    const peers = await helia.libp2p.peerStore.all({
      filters: [(peer) => peer.id.toString() === peerId],
      limit: 10,
    });

    res.send({
      length: peers.length,
      peer: peers,
    });
  } catch (err) {
    res.send({
      error: err.message,
    });
  }
});

app.get("/libp2p/dial", async (req, res) => {
  let peerId;
  let multiAddr;
  try {
    if (req.query.peerId) {
      peerId = peerIdFromString(req.query.peerId);
    }

    if (req.query.multiAddr) {
      multiAddr = multiaddr(req.query.multiAddr);
    }
  } catch (err) {
    console.log("Invalid peer ID:", err.message);
    res.send({
      success: false,
      error: "Invalid peer ID",
    });
    return;
  }

  if (multiAddr) {
    console.log(`Peering by multiaddress: ${multiAddr}`);
  } else if (peerId) {
    console.log(`Peering by PeerID: ${peerId}`);
  }

  try {
    const connection = await helia.libp2p.dial(multiAddr || peerId);
    res.send({ success: true, connection });
  } catch (err) {
    console.log("Cannot dial peer", err.message);

    res.send({
      success: false,
      error: err.message,
    });
    console.log(err);
  }
});

app.get("/libp2p/new-peers/log", async (req, res) => {
  logNewPeers = !logNewPeers;

  res.send({
    logNewPeers,
  });
});

app.get("/libp2p/connections", async (req, res) => {
  const peerId = req.query.peerId;
  const connections = helia.libp2p.getConnections(
    peerId ? peerIdFromString(peerId) : undefined,
  );

  res.send({
    length: connections.length,
    connections,
  });
});

app.get("/libp2p/status", async (req, res) => {
  res.send({
    status: helia.libp2p.status,
  });
});

app.get("/file/:cid", async (req, res) => {
  const cid = CID.parse(req.params.cid);
  const file = ifs.cat(cid);

  const chunks = [];
  for await (const chunk of file) {
    chunks.push(chunk);
  }

  res.set("Content-Type", "image/jpeg");
  res.send(Buffer.concat(chunks));

  // res.send({
  //   cid: cid?.toString(),
  //   file
  // });
});

app.get("/pins", async (req, res) => {
  const pins = [];

  for await (const pin of helia.pins.ls()) {
    console.log("PIN LS", pin);
    pins.push(pin);
  }

  res.send({
    pins,
  });
});

app.post("/pins/pin/:cid", async (req, res) => {
  const cid = CID.parse(req.params.cid);

  try {
    for await (const pin of helia.pins.add(cid)) {
      console.log("PINNED", pin);
    }
  } catch (err) {
    console.error("Error:", err.message);
    res.statusCode = 500;
    return res.send({
      error: err.message,
    });
  }

  res.send({
    pinned: true,
    cid: cid.toString(),
  });
});

app.get("/pins/isPinned/:cid", async (req, res) => {
  const cid = CID.parse(req.params.cid);

  const isPinned = await helia.pins.isPinned(cid);

  res.send({
    cid: cid.toString(),
    isPinned,
  });
});

app.post("/file/upload", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.statusCode = 400;
    return res.send("No file uploaded.");
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uploadDir = path.join(__dirname, "uploads"); // Directory where files will be uploaded

  const { buffer, originalname } = req.file;

  const cid = await ifs.addFile({
    path: `/${originalname}`,
    content: buffer,
  });
  console.log("Successfully added file", cid.toString());

  const isPinned = await helia.pins.isPinned(cid);
  if (isPinned) {
    console.log("File already pinned", cid.toString());
  } else {
    // Pin the file
    for await (const pinned of helia.pins.add(cid)) {
      console.log("Filed pinned", pinned);
    }
  }

  // Tell the network we can provide content for the passed CID
  await helia.libp2p.services.dht.provide(cid);
  console.log("Provided CID via DHT", cid.toString());

  // console.log("Provide");
  // void helia.routing.provide(cid);
  // console.log("Provide DONE");

  res.send({
    originalname,
    cid: cid.toString(),
  });

  // for await (const data of helia.pins.add(cid)) {
  //   console.log('pin data', data)
  // }
  // try {
  //   for await (const data of helia.libp2p.services.dht.provide(cid)) {
  //     console.log('provide data', data)
  //   }
  // } catch (err) {
  //   console.log('provide error', err)
  // }
  //
  // try {
  //   for await (const provs of helia.libp2p.services.dht.findProviders(cid)) {
  //     console.log('found providers', provs)
  //   }
  // } catch (err) {
  //   console.log('find providers error', err)
  // }

  // Provide the CIDs you create (once you're connected to a peer)
  try {
    // @ts-ignore
    // for await (const event of helia.libp2p.services.dht.provide(cid)) {
    //   console.log("PROVIDE", event);
    // }
  } catch (err) {
    console.log("An error occured while providing", err);
  }

  // fs.writeFile(
  //   path.join(uploadDir, "example.jpg"),
  //     buffer,
  //   "base64",
  //   (err) => {
  //     if (err) {
  //       res.statusCode = 500;
  //     }
  //   },
  // );

  // res.send({
  //   originalname,
  //   cid: cid.toString(),
  // });
  console.log("DONE");
});

app.post("/test", async (req, res) => {
  const textEncoder = new TextEncoder();
  const cid = await ifs.addFile({
    content: textEncoder.encode("Hello world asldgfhkasjdghsk;adjflkasgjd!"),
  });

  // @ts-ignore
  for await (const event of helia.libp2p.services.dht.provide(cid)) {
    console.log("PROVIDE", event);
  }

  res.send({
    cid: cid.toString(),
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
