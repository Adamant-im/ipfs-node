# ipfs-node
IPFS decentralized file storage and transfers

## How to start
- You will need nodejs v20.11.1 (You can install via nvm: https://github.com/nvm-sh/nvm):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```
- nvm install 20.11.1
- npm i -g pm2
- git clone https://github.com/Adamant-im/ipfs-node.git
- cd ipfs-node & npm i
- npm run build
- pm2 start dist/index.js --name="IPFS node"

## How to configure
Using config.default.json5 as a template, you can create various configuration files. 
For example:
`node dist/index.js test1` — this command will launch the server with the configuration from the file config.test1.json5

Options available for configuration:
- nodes — a list of IPFS ADAMANT nodes between which interaction will take place.
- storeFolder — the directory in which the files will be stored (the directory is set from the user’s root directory)
- logLevel — logging level: fatal, error, warn, info, debug, trace
- peerDiscovery.bootstrap  IPFS network nodes that will be used to search for new nodes. Details: https://github.com/libp2p/js-libp2p/tree/main/packages/peer-discovery-bootstrap
- peerDiscovery.listen — Addresses that helia will listen to.
- serverPort — Port on which the API server will be deployed
- diskUsageScanPeriod — Disk space scanning period. Set in cron format: '* * * * * *'
- uploadLimitSizeBytes — Maximum upload file size
- maxFileCount — Maximum upload count of files per request
- findFileTimeout — Time limit for searching for a file on the IPFS network
- cors.originRegexps — Sites from which requests to the node are allowed. Set using regular expressions.

## How to use
To upload a file to IPFS, you need to make a POST request `/api/file/upload`

Request body type: `form-data`

It should contain a "files" field, which can accept an array of files up to 5 pieces at a time.
Answer:
```json
{
  "filesNames": [
    "beach9.jpg" - name of the uploaded file
  ],
  "cids": [
  "bafkreiaeejc52w4pr6p4znyl77bljssgshvh4n23xpohkflrwxakpa42ra" - CID of the file
  ]
}
```

To find a file, you need to perform a GET request `/api/file/:cid`

The response will be a stream with the Content-Type header: `application/octet-stream`
