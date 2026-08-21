# ipfs-node

ADAMANT ipfs-node. Designed for downloading and exchanging files in the ADAMANT Messenger.

Unlike the standard libraries (helia or kubo), this ipfs-node is equipped with a web server for performing REST requests for downloading and receiving files.

The plans also include the implementation of the Garbage Collector function, which will save disk space by removing unsent files.

## How to start

- You will need Node.js v24 LTS (you can install it via [nvm](https://github.com/nvm-sh/nvm)):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

```bash
nvm install 24
```

The repository ships an `.nvmrc`, so `nvm use` picks the right version inside the project directory.

- Cloning and building the node:

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
```

```bash
cd ipfs-node && npm ci && npm run build
```

- Create a configuration file from the template:

```bash
cp config.default.json5 config.json5
```

- Running the node with [pm2](https://github.com/Unitech/pm2):

```bash
npm i -g pm2
```

```bash
pm2 start dist/index.js --name="IPFS node"
```

## How to configure

Using `config.default.json5` as a template, you can create various configuration files.

The config file is selected by the `IPFS_NODE_CONFIG` environment variable, or by the first CLI argument when the variable is not set. Both select `config.<name>.json5`; with neither, `config.json5` is used.

```bash
node dist/index.js test1
```

```bash
IPFS_NODE_CONFIG=test1 node dist/index.js
```

Both commands launch the server with the configuration from `config.test1.json5`.

The configuration is validated at startup. A missing file, invalid JSON5, or a field with the wrong type aborts the process with a `ConfigError` naming the offending field, instead of failing later at runtime.

```jsonc
{
  // List of IPFS ADAMANT nodes interacting between each other.
  // Their multiaddrs are also used as the libp2p connection manager allow list.
  nodes: [
    {
      name: "ipfs1",
      multiAddr: "/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq"
    },
    ...
  ],
  storeFolder: '.adm-ipfs', // File storage directory (the directory is set from the user’s home directory)
  logLevel: 'debug', // Logging level: fatal, error, warn, info, debug, trace, silent
  peerDiscovery: {
    // IPFS network nodes dialled on startup
    // Details: https://github.com/libp2p/js-libp2p/tree/main/packages/peer-discovery-bootstrap
    bootstrap: [
      '/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq',
      ...
    ],
    // Addresses that helia will listen to
    listen: [
      '/ip4/0.0.0.0/tcp/4001',
    ]
  },
  serverPort: 4000, // API server deployment port
  diskUsageScanPeriod: '*/30 * * * * *', // Disk space scanning period. Set in cron format: '* * * * * *'
  uploadLimitSizeBytes: 268435456, // Maximum upload file size (in bytes)
  maxFileCount: 10, // Maximum upload count of files per request
  findFileTimeout: 20000, // Time limit for searching for a file on the IPFS network
  cors: {
    // Allowed origins. A string, `true`/`false`, or an array of strings,
    // passed through to the `cors` package
    origin: '*',
    credentials: true
  }
}
```

## Network topology

The node forms a private mesh with the peers listed in `nodes` and `peerDiscovery.bootstrap`. libp2p is configured explicitly and the Helia defaults are not merged in, so the node runs:

- TCP transport only, with Noise encryption and Yamux stream multiplexing
- bootstrap peer discovery, restricted to the configured multiaddrs
- the `identify` and `ping` services only

There is no DHT, no mDNS discovery, no circuit relay, no NAT traversal, and no HTTP gateway routing. Blocks are exchanged with known peers over bitswap and block requests never leave the configured peer set.

The libp2p private key is stored in the datastore under `/pkcs8/self`, so a node keeps its peer identity across restarts as long as its `storeFolder` is preserved.

## Dependency notes

`helia` depends on `@helia/libp2p`, which depends on `@libp2p/webrtc` even when WebRTC is not configured. That pulls two things into the runtime dependency tree:

- `node-datachannel`, a native module. Its prebuilt binary is downloaded from GitHub during `npm install`, so an installer that can reach the npm registry but not GitHub releases will produce an install that fails at startup
- `react-native-webrtc`, and through it `react-native` and its Metro bundler

`npm audit --omit=dev` reports advisories against Metro and its `image-size` dependency. They are accepted residual findings: Metro is a React Native build tool that this service never loads, the advisories describe denial of service while parsing image files, and no upstream release resolves them without overriding a transitive dependency across a major version. CI therefore gates on `--audit-level=critical`. Re-check these findings whenever Helia is upgraded.

## Development

```bash
npm run dev
```

```bash
npm run lint
```

```bash
npm run format
```

```bash
npm test
```

`npm test` builds the project and then runs the unit and integration suites with Node's built-in test runner, using `config.test.json5`. The unit suite checks configuration validation, helper behaviour, and that uploads still produce the CIDs issued before the Helia migration. The integration suite starts two isolated nodes on loopback with temporary stores, transfers a file between them, and verifies that a peer identity survives a restart.

## How to use

### Upload file

Request body type: `form-data`

It should contain a "files" field, which can accept an array of files up to `maxFileCount` pieces at a time.

#### Request

```text
POST /api/file/upload
```

```bash
curl -i --location 'http://localhost:4000/api/file/upload' --form 'files=@"file.txt"'
```

#### Response

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
...

{"filesNames":["file.txt"],"cids":["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"]}
```

### Get file

#### Request

```text
GET /api/file/:cid
```

```bash
curl -i --location 'http://localhost:4000/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm'
```

#### Response

```text
HTTP/1.1 200 OK
Content-Type: application/octet-stream
...

Hello ipfs-node!
```

A CID that cannot be located within `findFileTimeout` returns `408`.

### Get node info

#### Request

```text
GET /api/node/info
```

```bash
curl -i --location 'http://localhost:4000/api/node/info'
```

#### Response

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
...

{
  "version": "0.0.1",
  "timestamp": 1720614998797,
  "heliaStatus": "started",
  "peerId": "12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9",
  "multiAddresses": [
    "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9",
    "/ip4/62.72.43.99/tcp/4001/p2p/12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9"
  ],
  "blockstoreSizeMb": 0.0009489059448242188,
  "datastoreSizeMb": 0.006007194519042969,
  "availableSizeInMb": 2257731
}
```

### Other endpoints

| Endpoint                                        | Description                                |
| ----------------------------------------------- | ------------------------------------------ |
| `GET /api/node/health`                          | Timestamp and Helia status                 |
| `GET /api/helia/pins`                           | List pinned CIDs                           |
| `POST /api/helia/pin/:cid`                      | Pin a CID                                  |
| `GET /api/helia/pins/isPinned/:cid`             | Whether a CID is pinned                    |
| `GET /api/libp2p/status`                        | libp2p status                              |
| `GET /api/libp2p/peers`                         | Connected peer ids                         |
| `GET /api/libp2p/connections`                   | Open connections                           |
| `GET /api/libp2p/peerStore`                     | Known peers                                |
| `GET /api/libp2p/peerInfo?peerId=`              | Stored data for one peer                   |
| `GET /api/libp2p/dial?peerId=` or `?multiAddr=` | Dial a peer                                |
| `GET /api/libp2p/services/ping?peerId=`         | Round-trip time to a peer, in milliseconds |
| `GET /api/debug/autopeering`                    | Dial every node from the config            |
