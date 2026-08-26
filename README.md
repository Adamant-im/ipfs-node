# ADAMANT IPFS node

This service embeds a Helia/libp2p node and exposes the file-transfer API used by ADAMANT Messenger. It stores uploaded files in an on-disk IPFS blockstore, pins them, retrieves content by CID, and maintains connections to configured peers.

The application is not a Kubo wrapper. It is a Node.js service with an Express REST API around an in-process Helia node.

## Requirements

- Node.js 24 LTS. The repository ships an `.nvmrc`, so `nvm use` selects it
- A TLS-terminating reverse proxy for every public deployment
- A unique administrative API key for operator endpoints

## Install and run

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
nvm use
npm ci
npm run build
node dist/index.js
```

`npm ci` must run install scripts. Helia depends on `@libp2p/webrtc`, whose
`node-datachannel` native module downloads a prebuilt binary from GitHub
releases; installing with `--ignore-scripts` produces a tree that fails at
startup. See [Dependency notes](#dependency-notes).

The process can also be managed with PM2:

```bash
npm install --global pm2
pm2 start dist/index.js --name="IPFS node"
```

## Configuration

Copy `config.default.json5` to `config.json5` and replace all deployment-specific values.

The config file is selected by the `IPFS_NODE_CONFIG` environment variable, or by the first CLI argument when the variable is not set. Both select `config.<name>.json5`; with neither, `config.json5` is used. `node dist/index.js test1` and `IPFS_NODE_CONFIG=test1 node dist/index.js` are equivalent.

The whole configuration is validated at startup: a missing file, invalid JSON5, or a field with the wrong type aborts the process with a message naming the offending field. The security-relevant fields are shown below:

```jsonc
{
  "serverPort": 4000,
  "uploadLimitSizeBytes": 268435456,
  "maxFileCount": 10,
  "cors": {
    "allowedOrigins": ["https://adm.im", "https://*.adamant.im", "http://localhost:8080"]
  },
  "trustProxy": false,
  "rateLimits": {
    "upload": { "windowMs": 900000, "limit": 10 },
    "pin": { "windowMs": 900000, "limit": 10 },
    "read": { "windowMs": 60000, "limit": 100 }
  },
  "adminApiKey": "",
  "enableDebugApi": false,
  "peeringSchedule": "*/30 * * * * *",
  "storage": {
    "maxRequestSizeBytes": 536870912,
    "maxConcurrentUploads": 32,
    "diskReserveBytes": 5368709120,
    "confirmationRequired": false,
    "temporaryTtlMs": 86400000,
    "gc": {
      "enabled": true,
      "schedule": "0 */15 * * * *",
      "highWatermarkBytes": 53687091200,
      "lowWatermarkBytes": 42949672960
    }
  },
  "replication": {
    "enabled": true,
    "placement": [
      { "minAgeMs": 0, "copies": 4 },
      { "minAgeMs": 15552000000, "copies": 3 },
      { "minAgeMs": 31536000000, "copies": 2 }
    ],
    "ackQuorum": 1,
    "requireQuorumOnUpload": false,
    "requestTimeoutMs": 30000,
    "repairEnabled": true,
    "repairSchedule": "0 */30 * * * *"
  }
}
```

`storage` and `replication` are optional; every option falls back to a documented default, so an existing configuration file keeps working. Both sections are described in [docs/storage-lifecycle.md](docs/storage-lifecycle.md), together with the file states, the collection policy, and the recovery procedures.

Generate the administrative secret before enabling operator endpoints:

```bash
openssl rand -hex 32
```

Set the generated value as `adminApiKey`. A missing or empty key fails closed: administrative routes return `503 Service not configured`. Known placeholder values and secrets shorter than 32 characters prevent startup.

### Configuration migration

- Remove `autoPeeringPeriod`; no scheduled auto-peering exists, and `GET /api/debug/autopeering` performs it on request
- Replace `cors.origin` or `cors.originRegexps` with `cors.allowedOrigins`
- Use exact origins such as `https://adm.im` or any-depth subdomain suffix wildcards such as `https://*.adamant.im`
- Set `adminApiKey` before using any administrative API
- Leave `trustProxy` as `false` for direct connections; configure exact proxy addresses, CIDR ranges, or a verified hop count behind a proxy
- Set `enableDebugApi: true` only when the authenticated debug route is operationally required
- Tune the endpoint-specific `rateLimits` for the deployment perimeter
- Review `storage.diskReserveBytes` and `storage.maxRequestSizeBytes` for the deployment volume; the defaults suit a dedicated disk
- `storage.gc.enabled` is on by default and frees blocks only when the blockstore passes `highWatermarkBytes` or free space falls into `diskReserveBytes`; released files stay readable until then
- `replication.enabled` is on by default and needs no key and no extra address: copies travel on a libp2p protocol between the peers already listed in `nodes`. Turning it off leaves every file in a single copy
- Tune `replication.placement` if the deployment wants a different number of copies per file age
- `peeringSchedule` is optional and defaults to every thirty seconds; it redials the peers in `nodes` that are not connected, which `autoPeeringPeriod` never did

Invalid CORS, proxy, API-key, or rate-limit configuration stops the process instead of silently weakening the boundary.

## HTTP access policy

| Class                | Routes                                                                                                                                                 | Policy                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public               | `GET /`, `GET /api/node/health`                                                                                                                        | No authentication                                                                                                                                                                                                                     |
| Public file transfer | `POST /api/file/upload`, `GET /api/file/:cid`                                                                                                          | No authentication; endpoint-specific rate limits and upload limits apply                                                                                                                                                              |
| Public storage state | `GET /api/file/:cid/status`, `GET /api/storage/metrics`, `GET /api/storage/policy`                                                                     | No authentication; no filename or peer topology is exposed                                                                                                                                                                            |
| Administrative       | `GET /api/node/info`, `POST /api/file/:cid/confirm`, `POST /api/file/:cid/unpin`, all `/api/storage/*` writes, all `/api/helia/*`, all `/api/libp2p/*` | A matching `x-api-key` header is required                                                                                                                                                                                             |
| Peer replication     | libp2p `/adamant/replication/1.0.0`, not an HTTP route                                                                                                 | Authenticated by the libp2p handshake. Pin, store, stage, commit, and abort are accepted only from the peers listed in `nodes`. `cache` is open to any peer (same effect as a public read), bounded by disk reserve and intake budget |
| Disabled by default  | all `/api/debug/*`                                                                                                                                     | Not mounted unless `enableDebugApi` is `true`; still requires `x-api-key`                                                                                                                                                             |
| Authenticated user   | None                                                                                                                                                   | The service has no end-user identity or session layer                                                                                                                                                                                 |

Administrative coverage includes pin operations, dial operations, peer-store data, connection data, status, peers, and topology-sensitive node information. CORS is a browser control and is never treated as authentication.

`GET /api/helia/routing/findProviders/:cid` no longer exists. Provider lookup requires content routing, and this deployment intentionally runs no DHT — see [Network topology](#network-topology).

### Public upload decision

Upload remains public for compatibility with direct Messenger clients. The service has no safe channel for distributing an upload secret and does not implement a short-lived signing protocol. Public upload is constrained by per-client request limits, per-file size, per-request file count, filename sanitization, and the deployment proxy.

This is an explicit compatibility decision, not an authorization guarantee. A deployment that requires signed upload authorization must enforce it at a trusted gateway until a client-compatible signing protocol is designed. Files of any content type are accepted, but downloads are served as `application/octet-stream` attachments with content sniffing disabled.

The multipart contract accepts `files` parts only. Text fields are rejected with a controlled `400 Bad Request` response.

An interrupted upload no longer leaves blocks behind. Each request owns a session that records the blocks it created; a rejected, aborted, or partially failed request removes exactly those, skipping blocks that already existed, blocks a concurrent upload is still writing, and blocks a pin protects. Whatever survives cleanup is unpinned and reclaimable by garbage collection. Strict-quorum uploads prepare rollback-capable remote pins and commit them concurrently only after the local decision is durable; success is returned only after permanent copies still satisfy the quorum. Blockstore growth is bounded by the disk reserve, the aggregate request size, the concurrency limit, and the collection watermarks — see [docs/storage-lifecycle.md](docs/storage-lifecycle.md).

### CORS

`cors.allowedOrigins` accepts canonical HTTP(S) origins only. It does not accept paths, credentials, query strings, fragments, or unrestricted `*`. Wildcards match subdomains at any depth beneath the configured suffix. For example, `https://*.adamant.im` matches both `https://chat.adamant.im` and `https://nested.chat.adamant.im`, but not `https://adamant.im` or `https://adamant.im.example.org`.

Requests without an `Origin` header, such as server-to-server calls and `curl`, are not blocked by CORS. Unauthorized administrative requests are still rejected by API-key middleware.

### Trusted proxy and rate limits

Express uses the socket address as the client IP while `trustProxy` is `false`. Behind a reverse proxy, set `trustProxy` to the exact proxy address or CIDR when possible:

```jsonc
trustProxy: ['127.0.0.1/8', '::1/128']
```

A numeric hop count is supported only for a fixed topology in which every path to the application has exactly that number of trusted hops. The blanket value `true` is rejected because a client could spoof `X-Forwarded-For` when the last proxy does not overwrite it.

Application limiters use in-memory counters per process. The TLS proxy must also enforce request rates, connection limits, header limits, and a body-size limit no larger than `uploadLimitSizeBytes` for multi-process or distributed deployments.

Keeping `trustProxy` disabled behind a proxy makes every client share the proxy's IP identity and therefore the same application rate-limit bucket. The process logs a startup warning for this configuration. Do not enable a broader trust rule merely to suppress the warning; configure only the known proxy addresses or a verified fixed hop count.

## Network topology

The node forms a private mesh with the peers listed in `nodes` and `peerDiscovery.bootstrap`. libp2p is configured explicitly and the Helia defaults are not merged in, so the node runs:

- TCP transport only, with Noise encryption and Yamux stream multiplexing
- bootstrap peer discovery, restricted to the configured multiaddrs
- the `identify` and `ping` services only

There is no DHT, no mDNS discovery, no circuit relay, no NAT traversal, and no HTTP gateway routing. Blocks are exchanged with known peers over bitswap, so block requests never leave the configured peer set and no CID is disclosed to a public gateway.

The node is composed from `createHeliaLight`, `withLibp2pLight`, and `withBitswap` rather than `createHelia`, because `createHelia` merges its default libp2p configuration into whatever is passed in. Keeping it would silently add mDNS, the public IPFS bootstrap list, kad-DHT, AutoNAT, AutoTLS, UPnP, circuit relay, and WebRTC/WebSocket transports.

The libp2p private key is stored in the datastore under `/pkcs8/self`, so a node keeps its peer identity across restarts as long as its `storeFolder` is preserved. Upgrading from the previous Helia 4 stack preserves both the peer identity and the existing blockstore contents; no store migration is required.

### TLS boundary

The Node.js process serves HTTP and does not terminate TLS. Bind it to a private interface or firewall it so clients can reach it only through a correctly configured HTTPS reverse proxy. The proxy must replace untrusted forwarding headers and forward requests to the configured `serverPort`.

Never expose the application port directly to the internet.

### Dependency audit policy

Run the production policy and static checks with:

```bash
npm run security:audit
npm run security:semgrep
```

The audit fails on every high or critical production advisory. There are no accepted exceptions: the Helia 4 Kademlia DHT advisory `GHSA-32mq-hpph-xfvr`, previously tolerated until the runtime upgrade, is resolved by the Helia 7 dependency set.

Use `npm run security:audit:raw` to inspect the unfiltered npm result.

## Dependency notes

`helia` depends on `@helia/libp2p`, which depends on `@libp2p/webrtc` even though WebRTC is never configured here. That pulls two things into the runtime tree:

- `node-datachannel`, a native module whose prebuilt binary is downloaded from GitHub releases during `npm install`. An installer that reaches the npm registry but not GitHub releases produces a tree that fails at startup, so `--ignore-scripts` is suitable only for auditing, not for running or testing
- `react-native-webrtc`, and through it `react-native` and its Metro bundler

`npm run security:audit` scopes the audit with `--omit=dev --omit=peer` and reports no findings. Running a bare `npm audit --omit=dev` additionally surfaces advisories against Metro and its `image-size` dependency; Metro is a React Native build tool that this service never loads. Re-check these when Helia is upgraded.

## Development

```bash
npm run dev
npm run lint
npm run format
npm test
```

`npm test` compiles `src` and `test` to `dist-test` and then runs the unit and integration suites with Node's built-in test runner against `config.test.json5`, which has no bootstrap peers and listens on loopback with an OS-assigned port.

The unit suites cover the HTTP security boundary, configuration validation, filename sanitization, disk measurement, and the file CIDs issued before the Helia migration. The integration suite starts two isolated nodes with temporary stores, transfers a file between them over bitswap, and verifies that a peer identity survives a restart.

### TypeScript project layout

Three configurations share one set of compiler options:

| File                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `tsconfig.json`       | Type-checks `src` and `test`. Emits nothing; this is what editors use |
| `tsconfig.build.json` | Builds `src` into `dist` for `npm run build`                          |
| `tsconfig.test.json`  | Builds `src` and `test` into `dist-test` for `npm test`               |

Type-check everything without emitting:

```bash
npx tsc --noEmit
```

Pass no file arguments to `tsc`. Naming a file on the command line makes TypeScript ignore `tsconfig.json` entirely, so `outDir` is not applied — the `.js` file is written next to its source — and the project's `lib`, `module`, and `moduleResolution` settings are replaced by defaults, which reports module-resolution and missing-`@types/node` errors that the project itself does not have.

## API usage

### Upload files

Send one or more `files` parts as multipart form data:

```bash
curl --fail-with-body \
  --form 'files=@file.txt' \
  https://ipfs.example.org/api/file/upload
```

Example response:

```json
{
  "filesNames": ["file.txt"],
  "cids": ["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"],
  "files": [
    {
      "cid": "bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm",
      "name": "file.txt",
      "state": "confirmed",
      "expiresAt": null
    }
  ],
  "replication": {
    "mode": "quorum",
    "desiredCopies": 4,
    "copies": 3,
    "required": 1,
    "acknowledged": 1,
    "replicaCount": 0,
    "cachedCount": 0,
    "satisfied": true,
    "networkTooSmall": true,
    "failedAttemptCount": 0,
    "attempts": []
  }
}
```

The `replication` object on this public route is counts and per-attempt
outcomes only: no node names, peer ids, or peer error text.

Upload responses use the following stable status contract:

| Status                      | Meaning                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `200 OK`                    | Every file was stored and pinned                                           |
| `400 Bad Request`           | No file was sent, too many files, or a single file exceeded its size limit |
| `413 Payload Too Large`     | The combined size of the files exceeded `storage.maxRequestSizeBytes`      |
| `429 Too Many Requests`     | The upload rate limit or the concurrent upload limit was exceeded          |
| `503 Service Unavailable`   | The replication quorum was required and could not be reached               |
| `507 Insufficient Storage`  | Storing the request would consume `storage.diskReserveBytes`               |
| `500 Internal Server Error` | Storage or replica settlement failed; do not treat it as a clean rejection |

### Check the state of a file

```bash
curl --fail-with-body \
  https://ipfs.example.org/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm/status
```

Example response:

```json
{
  "cid": "bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm",
  "state": "confirmed",
  "pinned": true,
  "createdAt": 1720614998797,
  "expiresAt": null,
  "confirmedAt": 1720614998797,
  "replication": { "acknowledged": 1, "required": 1, "heldLocally": true }
}
```

### Read the storage report and policy

```bash
curl --fail-with-body https://ipfs.example.org/api/storage/metrics
curl --fail-with-body https://ipfs.example.org/api/storage/policy
```

`metrics` reports pinned, reclaimable, available, and reserved bytes together with the lifecycle counters, and the libp2p replication protocol this node speaks — nodes on different protocol versions cannot place copies on each other, so a mixed deployment is visible here. `policy` reports the limits and the durability mode a client should expect before uploading.

### Download a file

```bash
curl --fail-with-body \
  --output file.bin \
  https://ipfs.example.org/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm
```

Download responses use the following stable status contract:

| Status                      | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `200 OK`                    | The response contains the requested file as an attachment              |
| `400 Bad Request`           | The CID is invalid                                                     |
| `408 Request Timeout`       | The file could not be found or retrieved before the configured timeout |
| `429 Too Many Requests`     | The read rate limit was exceeded                                       |
| `500 Internal Server Error` | An unexpected internal failure occurred before streaming started       |

The timeout status remains `408 Request Timeout` for compatibility with existing clients. If an error occurs after response bytes have started, the server terminates the incomplete response because an HTTP status and JSON error body can no longer be sent safely.

### Check public health

```bash
curl --fail-with-body https://ipfs.example.org/api/node/health
```

Example response:

```json
{
  "timestamp": 1720614998797,
  "heliaStatus": "started"
}
```

### Get administrative node information

```bash
curl --fail-with-body \
  --header 'x-api-key: your-generated-key' \
  https://ipfs.example.org/api/node/info
```

### Run garbage collection

Add `?dryRun=true` to report the exact CIDs that would be released and retained without deleting anything. This is the supported way to review a deletion policy before enabling the scheduled collector.

```bash
curl --fail-with-body --request POST \
  --header 'x-api-key: your-generated-key' \
  'https://ipfs.example.org/api/storage/gc?dryRun=true'
```

`POST /api/storage/repair` places copies of any confirmed file whose designated holders have not all acknowledged. A collection pass also hands over local copies of files that belong on other nodes, once those nodes confirm they hold them; the report lists them under `demoted`.

## Validation

```bash
npm ci
npm run build
npm run lint
npm run format
npm test
npm run security:audit
npm run security:semgrep
git diff --check
```
