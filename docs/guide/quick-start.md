---
title: Quick start
description: Build, configure, and run a single ADAMANT IPFS node from source, then verify health, upload, and download with curl.
---

# Quick start

The shortest path from an empty directory to a running node: clone, build, write a standalone
configuration, start the process, and confirm with `curl` that it stores and serves a file.

The result is a single node that joins no network. It stores one local copy of everything it
accepts and replicates nothing, which is enough to exercise the API and to decide whether the
service fits. Adding peers is a configuration change, not a rebuild. To run the same service as a
container instead, use [Docker](/guide/docker).

## Requirements

| Requirement        | Detail                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| Node.js 24         | `.nvmrc` pins the major version and `engines.node` is `>=24.0.0`             |
| Git and npm        | The project is distributed as source and is not published to npm             |
| Reverse proxy      | Required for any public deployment; the process does not terminate TLS       |
| Administrative key | Needed for operator endpoints; generate one with `openssl rand -hex 32`      |
| Two TCP ports      | `serverPort` for the HTTP API and the `peerDiscovery.listen` port for libp2p |

Install Node.js 24 with nvm so that `nvm use` inside the repository selects the version recorded in
`.nvmrc`. Any Node.js 24 installation works; `.nvmrc` only makes the choice explicit and keeps
contributors on one version.

TLS is not handled at the application level. The node logs a warning about this on every start, so
put a TLS-terminating reverse proxy in front of it before exposing it to the internet, and read
[Security](/guide/security) before doing so.

Administrative routes answer `503` while `adminApiKey` is empty. A non-empty key must be at least
32 characters and must not be one of the placeholder values the validator rejects, so generate a
real secret rather than editing an example by hand.

## Install and build

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
nvm use
npm ci
npm run build
node dist/index.js
```

`npm ci` must run install scripts. Helia depends on `@libp2p/webrtc`, whose
`node-datachannel` native module downloads a prebuilt binary during installation. npm 12 blocks
that download unless the package is listed in `package.json` `allowScripts`; this repository
already lists it. Installing with `--ignore-scripts` produces a dependency tree that fails at
startup; that flag is suitable only for auditing dependencies and for building the documentation
site.

The build compiles TypeScript into `dist/`. Rerun `npm run build` after every code change; the
running process does not pick up source edits on its own.

## Configure

Configuration is a JSON5 file in the repository root. The file is selected by the
`IPFS_NODE_CONFIG` environment variable, otherwise by the first CLI argument, otherwise by the name
`config.json5`. Both forms select `config.<name>.json5`, so `node dist/index.js test1` and
`IPFS_NODE_CONFIG=test1 node dist/index.js` are equivalent.

```bash
cp config.default.json5 config.json5
```

::: warning
`config.default.json5` is the ADAMANT production template. Its `nodes` list and its
`peerDiscovery.bootstrap` list point at the ADAMANT production mesh, and its `cors.allowedOrigins`
entries are ADAMANT origins. A deployment that is not joining ADAMANT must replace all three before
starting the node. Leaving `nodes` and `peerDiscovery.bootstrap` empty runs a standalone node.
:::

A minimal standalone configuration holds the required keys only:

```json5
{
  nodes: [],
  storeFolder: '.adm-ipfs',
  logLevel: 'info',
  peerDiscovery: {
    bootstrap: [],
    listen: ['/ip4/0.0.0.0/tcp/4001']
  },
  serverPort: 4000,
  diskUsageScanPeriod: '*/30 * * * * *',
  uploadLimitSizeBytes: 268435456,
  maxFileCount: 10,
  findFileTimeout: 20000,
  cors: {
    allowedOrigins: ['http://localhost:8080']
  },
  health: {
    requiredPeerCount: 0
  }
}
```

Every other option falls back to a documented default, including the whole `storage`,
`replication`, and `health` sections. [Configuration](/guide/configuration) lists each default and
the cross-field rules that are checked at startup.

Notes on the keys above:

- `nodes` and `peerDiscovery.bootstrap` are empty, so this node dials nobody and nobody is
  authorized to place replicas on it. The node dials only the peers a configuration lists, which
  keeps it off the public DHT and away from public gateways and reduces public exposure of
  content-routing metadata. That is not by itself privacy, anonymity, trustlessness, or censorship
  resistance
- `storeFolder` is resolved against the home directory of the process user, so this node keeps its
  blockstore and datastore in `$HOME/.adm-ipfs`. An absolute data directory is not implemented yet;
  it is tracked as [issue #30](https://github.com/Adamant-im/ipfs-node/issues/30)
- `peerDiscovery.listen` must contain at least one multiaddr even for a standalone node
- `cors.allowedOrigins` must be non-empty and accepts exact origins and any-depth subdomain
  wildcards such as `https://*.example.org`. A bare `*` is rejected. Requests without an `Origin`
  header, including `curl`, are not affected by CORS
- `health.requiredPeerCount` is `0` because there is no remote peer to attest a checkpoint round.
  It is also the default when fewer than two nodes are configured, and it can never exceed the
  number of configured remote peers

This configuration leaves `adminApiKey` unset, so every administrative route answers `503`. To use
them, add a generated key and send it as the `x-api-key` header:

```json5
{
  // openssl rand -hex 32
  adminApiKey: 'replace-with-output-of-openssl-rand-hex-32'
}
```

That exact placeholder is one of the values the validator refuses, so a configuration copied
without editing aborts at startup instead of running on a published secret.

Configuration is read once at startup, and validation aborts the process with a message naming the
offending field. A node that exits immediately after start is usually a configuration error; read
the first lines of its log.

## Run

Start the built entry point in the foreground:

```bash
node dist/index.js
```

The first log line reports the selected file, for example `Using config file: config.json5`.
Peering with the configured nodes runs before the API starts serving. Once the server is listening,
the node logs `Server is running on http://localhost:4000` followed by a warning that TLS is not
handled at the application level, and a warning that `trustProxy` is `false`. Both warnings are
expected on a fresh installation.

The HTTP server binds every interface on `serverPort`. Upload and download are public routes, so
keep the port behind a firewall or a reverse proxy while evaluating rather than exposing it
directly.

To run a named configuration:

```bash
IPFS_NODE_CONFIG=production node dist/index.js
```

Under PM2:

```bash
npm install --global pm2
pm2 start dist/index.js --name="IPFS node"
```

`SIGINT` and `SIGTERM` are each handled once. The node stops its scheduled jobs, stops replication
repair and the health service, closes the HTTP server, stops Helia, and exits with code `0`. Idle
connections are force-closed after 12 s, and a hard deadline at 15 s exits with code `1` after
logging `Shutdown timed out`, so any supervisor that stops this process should allow at least 20 s.

## Verify

`GET /` answers with the text `IPFS node`, which is the cheapest check that the process is
listening. Everything below assumes the node from the configuration above, running on port 4000.

### Health

```bash
curl --fail-with-body http://localhost:4000/api/node/health
```

This route always returns HTTP `200`. The status code says only that the process answered, so a
consumer must read the `state` field, which is one of `starting`, `ready`, `stale`, or `degraded`.
A check that looks at the status code alone will call a `degraded` node healthy.

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
    "requiredPeers": 0,
    "attestedPeers": 0
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

`membership.version` is a 64-character hex digest of the configured peer set, truncated above. A
new node reports `starting` until startup reconciliation finishes, and reaches `ready` only after a
checkpoint in which every prerequisite in `checks` passed. With the default replication settings
that includes a completed repair cycle, so allow for the first cycle and the first checkpoint
before expecting `ready`.

With `health.requiredPeerCount` at `0`, `checks.peerAttestations` is always true and a checkpoint
proves only this node's own prerequisites. Network coverage is unverified on a standalone node.
[Monitoring](/operations/monitoring) describes the full contract.

### Upload and download

Upload accepts multipart parts named `files`. Text fields are rejected with `400`.

```bash
curl --fail-with-body \
  --form 'files=@file.txt' \
  http://localhost:4000/api/file/upload
```

```json
{
  "filesNames": ["file.txt"],
  "cids": ["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"],
  "files": [
    {
      "cid": "bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm",
      "name": "file.txt",
      "state": "confirmed",
      "expiresAt": null,
      "replication": {
        "mode": "quorum",
        "desiredCopies": 4,
        "copies": 1,
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
  ],
  "replication": {
    "mode": "quorum",
    "desiredCopies": 4,
    "copies": 1,
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

Placement is decided per CID, so each entry of `files` carries its own report; the top-level
`replication` object repeats the first file's report for clients written against it. On a
standalone node the policy asks for four copies, one copy can exist, the local copy satisfies the
quorum, and `networkTooSmall` is true. The report carries counts and outcomes only, never node
names or peer ids.

Read the file back by CID:

```bash
curl --fail-with-body \
  --output downloaded.bin \
  http://localhost:4000/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm

cmp file.txt downloaded.bin
```

The response is the complete file, sent as an `application/octet-stream` attachment with content
sniffing disabled. It carries an `ETag` holding the quoted CID and a private one-hour
`Cache-Control` value that requires revalidation. Range requests are not served: the header is
ignored and responses carry `Accept-Ranges: none`.

A CID this node cannot retrieve is never answered with `404`, because the node cannot know that the
content does not exist anywhere. Retrieval that finds no holder ends in `408` after
`findFileTimeout`, which on a standalone node is the expected answer for any CID it did not store
itself.

### Upload and download status codes

| Status | Upload                                                           | Download                                           |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------- |
| `200`  | Every file was stored and pinned                                 | The response carries the complete file             |
| `304`  | —                                                                | The `If-None-Match` validator matched              |
| `400`  | No file, too many files, or one file over `uploadLimitSizeBytes` | The CID is invalid                                 |
| `408`  | —                                                                | Discovery or retrieval timed out                   |
| `413`  | Combined size over `storage.maxRequestSizeBytes`                 | —                                                  |
| `429`  | Upload rate or concurrency limit                                 | Read rate, per-client, or global concurrency limit |
| `503`  | A required replication quorum was not reached                    | —                                                  |
| `507`  | Storing the request would consume `storage.diskReserveBytes`     | —                                                  |
| `500`  | Storage or replica settlement failed; not a clean rejection      | Failure before streaming started                   |

### Effective limits

```bash
curl --fail-with-body http://localhost:4000/api/storage/policy
```

The response reports the limits and the durability mode a client should expect before uploading,
which is the fastest way to confirm that the running process uses the file that was just edited:

```json
{
  "maxFileCount": 10,
  "uploadLimitSizeBytes": 268435456,
  "maxRequestSizeBytes": 536870912,
  "maxConcurrentUploads": 32,
  "maxConcurrentDownloads": 64,
  "maxConcurrentDownloadsPerClient": 8,
  "confirmationRequired": false,
  "temporaryTtlMs": 86400000,
  "durability": {
    "mode": "quorum",
    "placement": [
      { "minAgeMs": 0, "copies": 4 },
      { "minAgeMs": 15552000000, "copies": 3 },
      { "minAgeMs": 31536000000, "copies": 2 }
    ],
    "ackQuorum": 1
  }
}
```

Every value outside `maxFileCount` and `uploadLimitSizeBytes` comes from a default, because the
minimal configuration sets neither `storage` nor `replication`.

## Next steps

- [Configuration](/guide/configuration) for every option, its default, and the validation rules
- [Security](/guide/security) for the TLS boundary, the administrative key, CORS, trusted proxies,
  and what the public routes do and do not authorize
- [Docker](/guide/docker) for the same service as a container with mounted configuration and one
  persistent volume
- [API reference](/reference/api) for the complete request and response contract
- [Monitoring](/operations/monitoring) for health states, checkpoints, and what to alert on
