# ipfs-node
ADAMANT ipfs-node. Designed for downloading and exchanging files in the ADAMANT Messenger. 

Unlike the standard libraries (helia or kubo), this ipfs-node is equipped with a web server for performing REST requests for downloading and receiving files.

The plans also include the implementation of the Garbage Collector function, which will save disk space by removing unsent files.

## How to start
- You will need Node.js v20.11.1 (You can install via nvm: https://github.com/nvm-sh/nvm):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20.11.1
```
- Cloning and building node:
```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node 
npm i
npm run build
```
- Running node with [pm2](https://github.com/Unitech/pm2):
```bash
npm i -g pm2
pm2 start dist/index.js --name="IPFS node"
```


## How to configure
Using `config.default.json5` as a template, you can create various configuration files. 

For example:
`node dist/index.js test1` — this command will launch the server with the configuration from the file config.test1.json5

```jsonc
{
  // List of IPFS ADAMANT nodes interacting between each other
  nodes: [
    {
      name: "ipfs1",
      multiAddr: "/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq"
    },
    ...
  ],
  storeFolder: '.adm-ipfs', // File storage directory (the directory is set from the user’s home directory)
  logLevel: 'debug', // Logging level: fatal, error, warn, info, debug, trace
  peerDiscovery: {
    // IPFS network nodes that will be used to search for new nodes
    // Details: https://github.com/libp2p/js-libp2p/tree/main/packages/peer-discovery-bootstrap
    bootstrap: [
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      ...
    ],
    // Addresses that helia will listen to
    listen: [
      '/ip4/0.0.0.0/tcp/4001',
    ]
  },
  serverPort: 4000, // API server deployment port
  autoPeeringPeriod: '*/10 * * * * *', 
  diskUsageScanPeriod: '*/30 * * * * *', // Disk space scanning period. Set in cron format: '* * * * * *'
  uploadLimitSizeBytes: 268435456, // Maximum upload file size (in bytes)
  maxFileCount: 5, // Maximum upload count of files per request
  findFileTimeout: 20000, // Time limit for searching for a file on the IPFS network 
  cors: {
    // Allowed URLs to make request to node. Set using regular expressions 
    originRegexps: ['.*\.adamant\.im', 'adm.im', '.*\.vercel\.app', '.*\.surge\.sh', 'localhost:8080']
  }
}
```

## How to use

### Upload file
Request body type: `form-data`

It should contain a "files" field, which can accept an array of files up to 5 pieces at a time.

#### Request
```POST /api/file/upload```
```bash
curl -i --location 'http://localhost:4000/api/file/upload' --form 'files=@"file.txt"'
```

#### Response
```
HTTP/1.1 200 OK
X-Powered-By: Express
Vary: Origin
Content-Type: application/json; charset=utf-8
Content-Length: 98
ETag: W/"62-79lDutTrkZZgROcnYebNgQPnqhQ"
Date: Wed, 10 Jul 2024 12:18:50 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"filesNames":["file.txt"],"cids":["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"]}
```

### Get file

#### Request
```GET /api/file/:cid```
```bash
curl -i --location 'http://localhost:4000/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm'
```

#### Response
```
HTTP/1.1 200 OK
X-Powered-By: Express
Vary: Origin
Content-Type: application/octet-stream
Content-Length: 17
Date: Wed, 10 Jul 2024 12:23:39 GMT
Connection: keep-alive
Keep-Alive: timeout=5

Hello ipfs-node!
```

### Get node info

#### Request
```GET /api/node/info```
```bash
curl -i --location 'http://localhost:4000/api/node/info'
```

#### Response
```
HTTP/1.1 200 OK
X-Powered-By: Express
Vary: Origin
Content-Type: application/json; charset=utf-8
Content-Length: 428
ETag: W/"1ac-gZEDVXGiPiendFaMWoAHkwBk/cY"
Date: Wed, 10 Jul 2024 12:36:38 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{
  "version":"0.0.1",
  "timestamp":1720614998797,
  "heliaStatus":"started",
  "peerId":"12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9",
  "multiAddresses":[
    "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9",
    "/ip4/62.72.43.99/tcp/4001/p2p/12D3KooWJSiMDfyDLK3EMe2567sSM1VKQVnUn2getimGqVTWqKX9"
  ],
  "blockstoreSizeMb":0.0009489059448242188,
  "datastoreSizeMb":0.006007194519042969,
  "availableSizeInMb":2257731
}
```
