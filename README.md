# ADAMANT IPFS node

This service embeds a Helia/libp2p node and exposes the file-transfer API used by ADAMANT Messenger. It stores uploaded files in an on-disk IPFS blockstore, pins them, retrieves content by CID, and maintains connections to configured peers.

The application is not a Kubo wrapper. It is a Node.js service with an Express REST API around an in-process Helia node.

The stable client and lifecycle contract is also available as [OpenAPI 3.1](docs/openapi.yaml).

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
  "findFileTimeout": 20000,
  "downloadIdleTimeout": 20000,
  "downloadMinBytesPerSecond": 32768,
  "downloadMaxDurationMs": 14400000,
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
  "prettyLogs": false,
  "peeringSchedule": "*/30 * * * * *",
  "storage": {
    "maxRequestSizeBytes": 536870912,
    "maxConcurrentUploads": 32,
    "maxConcurrentDownloads": 64,
    "maxConcurrentDownloadsPerClient": 8,
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
    "repairSchedule": "0 */30 * * * *",
    "repairBatchDelayMs": 1000,
    "repairProbeConcurrency": 4
  },
  "health": {
    "checkpointIntervalMs": 60000,
    "maxCheckpointAgeMs": 180000,
    "storageMaxAgeMs": 120000,
    "repairMaxAgeMs": 3600000,
    "clockSkewToleranceMs": 10000,
    "peerAttestationTimeoutMs": 5000,
    "requiredPeerCount": 1
  }
}
```

`findFileTimeout` bounds discovery, while `downloadIdleTimeout` (defaulting to
`findFileTimeout`) bounds a stalled transfer. `downloadMinBytesPerSecond`
(default `32768`) derives a complete-transfer deadline from the file size, while
`downloadMaxDurationMs` (default four hours) provides an absolute ceiling.
`storage.maxConcurrentDownloads` (default `64`) bounds sockets and UnixFS
iterators globally, and `storage.maxConcurrentDownloadsPerClient` (default `8`)
keeps one address from holding every slot. Discovery, stat, and streaming have
separate bounds, so a failed request may spend more than one `findFileTimeout`
before returning `408`.

Startup refuses a `downloadMaxDurationMs` below the time `uploadLimitSizeBytes`
needs at `downloadMinBytesPerSecond`: the ceiling wins over the size-aware
deadline, so a lower value would cut the largest permitted files off mid-stream
and report them as retrieval timeouts.

`storage`, `replication`, and `health` are optional; every option falls back to a documented default, so an existing configuration file keeps working. Storage and replication are described in [docs/storage-lifecycle.md](docs/storage-lifecycle.md), together with the file states, the collection policy, and the recovery procedures.

Logs are newline-delimited JSON by default. Set `prettyLogs: true` only for an interactive development terminal; production collectors should keep the structured fields emitted by Pino and the health checkpoint.

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
- Migrate operator scripts and dashboards from the former detailed `GET /api/node/info` response to authenticated `GET /api/node/details`; `/info` is now the public legacy PWA/iOS contract
- Set `enableDebugApi: true` only when the authenticated debug route is operationally required
- Tune the endpoint-specific `rateLimits` for the deployment perimeter
- Review `storage.diskReserveBytes` and `storage.maxRequestSizeBytes` for the deployment volume; the defaults suit a dedicated disk
- `storage.gc.enabled` is on by default and frees blocks only when the blockstore passes `highWatermarkBytes` or free space falls into `diskReserveBytes`; released files stay readable until then
- `replication.enabled` is on by default and needs no key and no extra address: copies travel on a libp2p protocol between the peers already listed in `nodes`. Turning it off leaves every file in a single copy
- Tune `replication.placement` if the deployment wants a different number of copies per file age
- Keep `health.requiredPeerCount` within the number of configured remote peers. A single-node or test deployment may set it to `0`
- `peeringSchedule` is optional and defaults to every thirty seconds; it redials the peers in `nodes` that are not connected, which `autoPeeringPeriod` never did

Invalid CORS, proxy, API-key, or rate-limit configuration stops the process instead of silently weakening the boundary.

## HTTP access policy

| Class                | Routes                                                                                                                                                    | Policy                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public               | `GET /`, `GET /api/node/health`, `GET /api/node/info`                                                                                                     | No authentication. `/info` is the sanitized legacy PWA/iOS contract                                                                                                                         |
| Public file transfer | `POST /api/file/upload`, `GET /api/file/:cid`                                                                                                             | No authentication; endpoint-specific rate limits and upload limits apply                                                                                                                    |
| Public storage state | `GET /api/file/:cid/status`, `GET /api/storage/metrics`, `GET /api/storage/policy`                                                                        | No authentication; no filename or peer topology is exposed                                                                                                                                  |
| Administrative       | `GET /api/node/details`, `POST /api/file/:cid/confirm`, `POST /api/file/:cid/unpin`, all `/api/storage/*` writes, all `/api/helia/*`, all `/api/libp2p/*` | A matching `x-api-key` header is required                                                                                                                                                   |
| Peer protocols       | libp2p `/adamant/replication/1.0.0` and `/adamant/health/1.0.0`, not HTTP routes                                                                          | Authenticated by the libp2p handshake. Health attestations and durable replication operations are accepted only from peers listed in `nodes`; open cache remains bounded like a public read |
| Disabled by default  | all `/api/debug/*`                                                                                                                                        | Not mounted unless `enableDebugApi` is `true`; still requires `x-api-key`                                                                                                                   |
| Authenticated user   | None                                                                                                                                                      | The service has no end-user identity or session layer                                                                                                                                       |

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
npm run typecheck
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

Discovery, idle transfer time, and the size-aware complete transfer all have bounded timeouts and remain `408 Request Timeout` for compatibility with existing clients. Client disconnect cancels the underlying retrieval. Range headers are ignored and the server returns the complete `200` representation with `Accept-Ranges: none`, preserving current PWA/iOS behavior. Successful responses include an `ETag` and private one-hour caching with revalidation; a matching `If-None-Match` returns `304` after availability has been checked. If an error occurs after response bytes have started, the server terminates the incomplete response because an HTTP status and JSON error body can no longer be sent safely.

### Check public health

```bash
curl --fail-with-body https://ipfs.example.org/api/node/health
```

Example response:

```json
{
  "version": "0.1.0",
  "uptimeMs": 123456,
  "state": "ready",
  "height": 1720614960000,
  "timestamp": 1720614998797,
  "evaluatedAt": 1720614998700,
  "checkpoint": {
    "intervalMs": 60000,
    "observedAt": 1720614998700,
    "ageMs": 97,
    "maxAgeMs": 180000
  },
  "membership": {
    "version": "d0f1...",
    "requiredPeers": 1,
    "attestedPeers": 2
  },
  "startup": { "complete": true, "healthy": true },
  "storage": {
    "measuredAt": 1720614980000,
    "measurementAgeMs": 18797,
    "reserveHealthy": true
  },
  "replication": {
    "repairRequired": true,
    "lastCompleteAt": 1720614900000,
    "ageMs": 98797,
    "backlog": 0
  },
  "checks": {
    "checkpointFresh": true,
    "clockConsistent": true,
    "helia": true,
    "startupReconciliation": true,
    "storageFresh": true,
    "storageReserve": true,
    "repairFresh": true,
    "peerAttestations": true
  }
}
```

The endpoint always returns `200`; consumers must inspect `state`. `height` is a persisted, monotonic Unix-millisecond checkpoint at the start of a fixed round. It advances only when startup reconciliation, storage freshness and reserve, a complete successful repair cycle with no known backlog, and the configured peer attestations all pass. It freezes on failure. Observation timestamps and ages let clients reject an absolutely stale cluster even when every node reports the same height. `starting`, `degraded`, and `stale` distinguish warm-up, a current failed prerequisite, and an expired last checkpoint.

State changes are deliberately asymmetric. The response is served from the last checkpoint, and reading it recomputes only what elapsed time can decide, so a node may be downgraded to `degraded` or `stale` between checkpoints. Recovery is never decided on a read: returning to `ready` requires a successful checkpoint, so expect up to `health.checkpointIntervalMs` of lag after the underlying fault clears. A clock that moves behind the checkpoint this node already recorded clears `clockConsistent` and stops advancement until it catches up, rather than persisting a round that starts after it finished. `checkpointFresh`, `storageFresh`, and `repairFresh` follow the same rule; every other entry in `checks`, along with `membership` and `startup`, describes `evaluatedAt` — the last checkpoint attempt, which may be a failed one — and not the moment of the request. `checkpoint.observedAt` dates the last attempt that _succeeded_, so the two differ whenever the most recent attempt failed. Peers may attest an adjacent round across a boundary, so two healthy nodes can briefly report heights one `checkpointIntervalMs` apart.

`membership.version` identifies the configured peer-set epoch. Changing the node list resets the persisted checkpoint for that node: `height` remains `0` until the first valid checkpoint under the new membership. Clients must compare heights only when membership versions match and treat a version change as a new epoch.

During a staged deployment, older peers do not implement the health protocol. Set `health.requiredPeerCount` to `0` on the transitioning fleet, then raise it after every required peer is upgraded; otherwise prolonged `degraded` health is the expected fail-safe result. While it is `0`, `checks.peerAttestations` is always `true` and the checkpoint proves only this node's own prerequisites: network coverage is not validated until the threshold is raised, so treat the transition window as unverified for routing decisions that depend on it.

Repair runs in bounded 50-record passes. The same selected batch feeds both local-holder repair and released-record rescue. A scheduled run starts a full cycle immediately and continues its remaining passes after `replication.repairBatchDelayMs`; this delay and `replication.repairProbeConcurrency` control peer load, while `repairSchedule` controls when a new completed cycle is refreshed. Set `health.repairMaxAgeMs` longer than the largest expected full-cycle duration plus the schedule interval. An incomplete or backlogged cycle intentionally keeps health degraded.

### Get legacy client node information

```bash
curl --fail-with-body https://ipfs.example.org/api/node/info
```

This public compatibility route retains `version`, `timestamp`, `heliaStatus`, `blockstoreSizeMb`, `datastoreSizeMb`, and `availableSizeInMb` for the current PWA and iOS application. It does not expose peer identity or topology.

### Get administrative node information

```bash
curl --fail-with-body \
  --header 'x-api-key: your-generated-key' \
  https://ipfs.example.org/api/node/details
```

The authenticated response adds peer addresses, byte-accurate storage figures, checkpoint detail, and bounded HTTP counters without paths, CIDs, IP addresses, or user-controlled metric labels.

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
