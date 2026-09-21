---
title: Configuration
description: Complete reference for the JSON5 configuration file, its defaults, its validation rules, and the cross-field checks that abort startup.
---

# Configuration

The node reads one JSON5 file at startup, validates it in full, and aborts if anything is wrong.
There is no environment-variable override for individual options: the file is the whole
configuration surface, and `IPFS_NODE_CONFIG` only chooses which file is read.

Every default printed on this page comes from `src/config.ts`, `src/security/config.ts`,
`src/security/cors.ts`, `src/security/trustProxy.ts`, `src/security/rateLimit.ts`,
`src/middleware/rateLimiter.ts` and `src/storage/config.ts`.

## Selecting a configuration file

The file name is resolved in this order:

1. `IPFS_NODE_CONFIG`, if set and non-empty
2. the first command-line argument, if present
3. `config.json5`

A name selects `config.<name>.json5`, so the two forms below are equivalent.

```bash
node dist/index.js                          # config.json5
node dist/index.js test1                    # config.test1.json5
IPFS_NODE_CONFIG=test1 node dist/index.js   # config.test1.json5
```

The environment variable wins over the argument, which matters when a process manager owns the
argument list.

The file is read from the repository root, located by walking up from the compiled entry point to
the nearest `package.json`. In the container image that root is `/app`, so the configuration is
mounted at `/app/config.json5`. See [Docker](/guide/docker).

`config.default.json5` is a template, never a selected file. Its `nodes` and
`peerDiscovery.bootstrap` entries point at the ADAMANT production mesh, so copy it as a starting
shape and replace the peer list with your own before starting a deployment. The first log line
names the file actually in use:

```text
Using config file: config.json5
```

## Validation

The whole file is parsed and validated before any cron job, the libp2p host, or the HTTP server
starts. A failure throws and the process exits.

- Most failures carry the field path: `Invalid config: "storage.gc.lowWatermarkBytes" must be lower than storage.gc.highWatermarkBytes`
- The security section throws its own messages, such as `adminApiKey must be an empty value or a unique secret of at least 32 characters`
- An unreadable or unparseable file fails with `Cannot read config file <path>` or `Cannot parse config file <path>`

Two properties are worth relying on:

- Unknown keys are ignored. A deployment can keep extra keys in the file, and a key removed from a
  past release stays silently inert rather than blocking startup.
- The format is JSON5, so comments, unquoted keys, single quotes, and trailing commas are all
  accepted

The `storage`, `replication`, and `health` sections are optional as a whole, and every key inside
them falls back to a documented default. Everything marked "required" below has no default.

Cron expressions are only checked for being non-empty strings during validation; an invalid
expression throws when the job is constructed, which is still before the API serves traffic.

## Core options

| Option                      | Type             | Default                       | Description                                                                                                 |
| --------------------------- | ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `nodes`                     | array of objects | required                      | Peer nodes this node replicates with and keeps connections to. May be empty for a standalone node.          |
| `nodes[].name`              | string           | required                      | Non-empty label used in logs and peering output                                                             |
| `nodes[].multiAddr`         | string           | required                      | Multiaddr containing a `/p2p/<peer-id>` component                                                           |
| `storeFolder`               | string           | required                      | Directory name resolved against the home directory of the process user                                      |
| `logLevel`                  | string           | required                      | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                         |
| `prettyLogs`                | boolean          | `false`                       | Routes logs through `pino-pretty`. Leave false in production: the default output is newline-delimited JSON. |
| `peerDiscovery.bootstrap`   | array of strings | required                      | Multiaddrs dialled once at startup. May be empty.                                                           |
| `peerDiscovery.listen`      | array of strings | required                      | libp2p listen multiaddrs, at least one                                                                      |
| `serverPort`                | integer >= 1     | required                      | HTTP API port                                                                                               |
| `diskUsageScanPeriod`       | cron string      | required                      | How often the storage scan that feeds the metrics runs                                                      |
| `peeringSchedule`           | cron string      | `*/30 * * * * *`              | How often connected entries of `nodes` are pinged and missing entries are redialled                         |
| `uploadLimitSizeBytes`      | integer >= 1     | required                      | Maximum size of one uploaded file                                                                           |
| `maxFileCount`              | integer 1-100    | required                      | Maximum number of files in one upload request                                                               |
| `findFileTimeout`           | integer >= 1     | required                      | Milliseconds allowed for locating a file before a download fails                                            |
| `downloadIdleTimeout`       | integer >= 1     | `findFileTimeout`             | Maximum pause between download chunks, in milliseconds                                                      |
| `downloadMinBytesPerSecond` | integer >= 1     | `32768`                       | Rate used to derive a size-aware complete-transfer deadline                                                 |
| `downloadMaxDurationMs`     | integer >= 1     | `max(14400000, size-derived)` | Absolute ceiling for one download response, in milliseconds                                                 |

Notes on the less obvious entries:

- `storeFolder` is always resolved from the home directory, so the persistent path is
  `$HOME/<storeFolder>`, holding `blockstore/` and `datastore/`. An optional absolute `dataDir` is
  tracked as [issue #30](https://github.com/Adamant-im/ipfs-node/issues/30) and is not implemented.
- `nodes` is more than a peer list. The same multiaddrs form the libp2p connection-manager allow
  list, and durable replication and health attestations are accepted only from those peers. Listing
  the node itself is harmless: its own peer id is filtered out before dialling, which lets every
  node in a deployment run the same list.
- Restricting peers this way avoids the public DHT and public gateways and reduces public exposure
  of content-routing metadata. It does not by itself make a deployment private, anonymous,
  trustless, or censorship-proof; content served over `GET /api/file/:cid` is public to anyone who
  has the CID.
- `peerDiscovery.bootstrap` dials once at startup and never again, which is why `peeringSchedule`
  exists. Without a peering schedule a mesh never recovers from a restart. The same job pings
  connected configured peers and hangs up any that miss the ping so the tick can redial them. Ping
  is a cheap liveness signal, not a bitswap or replication health check.
- The cron examples use the six-field form with a leading seconds field
- `downloadMaxDurationMs` caps the deadline of a single response. The effective deadline is the
  smaller of this ceiling and the size-aware deadline
  `ceil(fileSize / downloadMinBytesPerSecond) * 1000 + downloadIdleTimeout`.

## CORS

`cors.allowedOrigins` is required and must be a non-empty array. Each entry is either a canonical
HTTP or HTTPS origin, or an any-depth subdomain wildcard.

| Option                | Type             | Default  | Description                         |
| --------------------- | ---------------- | -------- | ----------------------------------- |
| `cors.allowedOrigins` | array of strings | required | Browser origins accepted by the API |

Entry rules, enforced when the matcher is compiled:

- Each entry is a non-empty string of at most 255 characters
- An exact origin must be canonical: scheme `http` or `https`, no credentials, no `*` in the
  hostname, path exactly `/`, no query string, no fragment, and no trailing slash. The string must
  equal the parsed origin exactly.
- A wildcard has the form `https://*.example.org`, optionally with a port. The suffix hostname must
  contain a dot, must not start or end with a dot, must not contain `..`, and must be at most 253
  characters. A port above 65535 is rejected.
- A bare `*` is rejected in every position

Matching is exact on scheme and port. A wildcard matches any subdomain at any depth but never the
suffix origin itself, so `https://*.example.org` accepts `https://app.example.org` and
`https://a.b.example.org` but not `https://example.org`. Add the bare origin as its own entry when
it is needed.

A request without an `Origin` header is treated as a non-browser request and is allowed. CORS is a
browser-side control: it does not authenticate anything, and it does not restrict `curl` or any
server-side client.

The rest of the CORS response is fixed and not configurable:

| Property        | Value                       |
| --------------- | --------------------------- |
| Methods         | `GET`, `POST`               |
| Allowed headers | `content-type`, `x-api-key` |
| Credentials     | disabled                    |
| Preflight cache | 600 seconds                 |

## Trusted proxy

`trustProxy` is passed to the Express `trust proxy` setting after validation. It decides which
address a request is attributed to, which is what the rate limiters key on.

| Option       | Type                                               | Default | Description                                                        |
| ------------ | -------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `trustProxy` | `false`, integer >= 1, string, or array of strings | `false` | Verified proxy hop count, or exact proxy addresses and CIDR ranges |

Accepted forms:

- `false` — no proxy is trusted, and the socket address is the client address
- a positive integer — the number of verified hops in front of this process
- a string — one exact address or CIDR range
- a non-empty array of strings — several addresses or ranges

Rejected forms:

- `true`, which would trust every forwarded address
- `*`, `0.0.0.0/0`, and `::/0`
- comma-separated values inside one string
- strings with surrounding whitespace, and empty strings

Behind a reverse proxy, list the exact proxy addresses. While `trustProxy` is `false` the node logs
a warning at startup, because every client behind a proxy would otherwise share the proxy address
for rate-limiting purposes.

## Rate limits

`rateLimits` holds three independent policies. Each key resolves on its own, so setting only
`rateLimits.upload` leaves `pin` and `read` at their defaults.

| Option                       | Type          | Default                           | Description                                                                       |
| ---------------------------- | ------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `rateLimits.upload`          | policy object | `{ windowMs: 900000, limit: 10 }` | Applies to `POST /api/file/upload`                                                |
| `rateLimits.pin`             | policy object | `{ windowMs: 900000, limit: 10 }` | Applies to `POST /api/helia/pin/:cid`                                             |
| `rateLimits.read`            | policy object | `{ windowMs: 60000, limit: 100 }` | Applies to the public read routes and the administrative read routes listed below |
| `rateLimits.<name>.windowMs` | integer >= 1  | see above                         | Fixed window length in milliseconds                                               |
| `rateLimits.<name>.limit`    | integer >= 1  | see above                         | Requests allowed per window per client address                                    |

The `read` policy covers `GET /api/file/:cid`, `GET /api/file/:cid/status`,
`GET /api/node/info`, `GET /api/storage/metrics`, `GET /api/storage/policy`,
`GET /api/helia/pins`, and `GET /api/helia/pins/isPinned/:cid`.

Behaviour of the limiters:

- Exceeding a window returns `429` with the body `{"error":"Too many requests. Please try again later."}`
- Standard `RateLimit` headers are sent in the IETF draft-8 form; the legacy `X-RateLimit-*` headers
  are disabled
- The window is fixed, not sliding, and keyed by the client address that `trustProxy` resolves

These limits are separate from the storage concurrency limits, which also answer `429`; see
[Storage options](#storage-options).

## Administrative access

| Option           | Type    | Default | Description                                                        |
| ---------------- | ------- | ------- | ------------------------------------------------------------------ |
| `adminApiKey`    | string  | `''`    | Secret required in the `x-api-key` header on administrative routes |
| `enableDebugApi` | boolean | `false` | Mounts `/api/debug/*`, which still requires the key                |

Rules for `adminApiKey`:

- An empty value disables administrative access. Every administrative route then answers `503` with
  `{"error":"Service not configured"}`, and the node still serves the public routes normally.
- A non-empty value must be a string of at least 32 characters
- The placeholders `change-me-use-openssl-rand-hex-32`, `replace-with-output-of-openssl-rand-hex-32`
  and `your-generated-key-here` are rejected

Generate a key with:

```bash
openssl rand -hex 32
```

A missing or non-matching `x-api-key` header returns `401` with `{"error":"Unauthorized"}`. The
comparison runs over a keyed digest in constant time, and authenticated responses carry
`Cache-Control: no-store`.

`enableDebugApi: false` does not merely reject debug requests: the router is never mounted, so
`/api/debug/autopeering` returns the standard not-found response. Enabling it still requires a
configured key. Which routes are public and which are administrative is listed in
[Security](/guide/security) and in the generated [endpoint reference](/reference/endpoints).

## Storage options

The `storage` section bounds what one node accepts and how much of the disk it may use. The whole
section is optional.

| Option                                    | Type         | Default          | Description                                                                                                                      |
| ----------------------------------------- | ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `storage.maxRequestSizeBytes`             | integer >= 1 | `536870912`      | Combined size of all files in one upload request. Over this the request is rejected with `413`.                                  |
| `storage.maxConcurrentUploads`            | integer >= 1 | `32`             | Upload requests writing into the blockstore at once. Over this the request is rejected with `429`.                               |
| `storage.maxConcurrentDownloads`          | integer >= 1 | `64`             | File responses retrieving content at once. Over this the request is rejected with `429`.                                         |
| `storage.maxConcurrentDownloadsPerClient` | integer >= 1 | `8`              | Share of the global download slots one client address may hold                                                                   |
| `storage.diskReserveBytes`                | integer >= 0 | `5368709120`     | Free space on the blockstore filesystem that uploads must never consume. An upload that would consume it is rejected with `507`. |
| `storage.confirmationRequired`            | boolean      | `false`          | Keeps an upload temporary until `POST /api/file/:cid/confirm`                                                                    |
| `storage.temporaryTtlMs`                  | integer >= 1 | `86400000`       | Lifetime of an unconfirmed upload before it becomes reclaimable                                                                  |
| `storage.gc.enabled`                      | boolean      | `true`           | Runs the scheduled collector. `POST /api/storage/gc` works regardless.                                                           |
| `storage.gc.schedule`                     | cron string  | `0 */15 * * * *` | Collector schedule                                                                                                               |
| `storage.gc.highWatermarkBytes`           | integer >= 1 | `53687091200`    | Blockstore size above which collection starts                                                                                    |
| `storage.gc.lowWatermarkBytes`            | integer >= 1 | `42949672960`    | Blockstore size collection reclaims down to                                                                                      |

The collector frees blocks only when space is short: above the high watermark, or once free space
falls into `diskReserveBytes`. Leaving `gc.enabled` on therefore costs nothing until a threshold is
reached.

Setting `storage.confirmationRequired: true` is a protocol change, not a tuning knob: clients must
call `POST /api/file/:cid/confirm` with the administrative key, and anything they upload without it
is reclaimed after `temporaryTtlMs`. The states and transitions are described in
[the storage lifecycle](/storage-lifecycle).

## Replication options

The `replication` section decides how many nodes hold a file and how missing copies are restored.
The whole section is optional.

| Option                               | Type           | Default                                                                                                    | Description                                                                             |
| ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `replication.enabled`                | boolean        | `true`                                                                                                     | Whether this node places copies of its own content on its peers                         |
| `replication.placement`              | array of tiers | `[{ minAgeMs: 0, copies: 4 }, { minAgeMs: 15552000000, copies: 3 }, { minAgeMs: 31536000000, copies: 2 }]` | Target copy count by file age, including this node                                      |
| `replication.placement[].minAgeMs`   | integer >= 0   | `0`                                                                                                        | Age at which the tier starts applying                                                   |
| `replication.placement[].copies`     | integer >= 1   | `1`                                                                                                        | Nodes that should hold a file in that tier                                              |
| `replication.ackQuorum`              | integer >= 1   | `1`                                                                                                        | Acknowledgements counted before an upload is reported durable, including the local copy |
| `replication.requireQuorumOnUpload`  | boolean        | `false`                                                                                                    | Fails an upload with `503` when the quorum is not reached                               |
| `replication.requestTimeoutMs`       | integer >= 1   | `30000`                                                                                                    | Timeout of one replication request to a peer                                            |
| `replication.repairEnabled`          | boolean        | `true`                                                                                                     | Runs the scheduled repair job                                                           |
| `replication.repairSchedule`         | cron string    | `0 */30 * * * *`                                                                                           | Repair schedule                                                                         |
| `replication.repairBatchDelayMs`     | integer >= 0   | `1000`                                                                                                     | Pause between bounded passes inside one full repair cycle                               |
| `replication.repairProbeConcurrency` | integer >= 1   | `4`                                                                                                        | Released records probed concurrently during one pass                                    |

The default tiers reduce copies at 180 days and at 365 days. Copies are reduced by file age rather
than by access time, which would record when users fetch their files.

`replication.enabled: false` stops this node from placing copies of its own content; it keeps
answering peers that want to place a copy here. That asymmetry is deliberate, so a new node can join
without every existing node being reconfigured first.

Durability settings are not availability guarantees. Whether a copy survives depends on independent
nodes, independent operators, and what each of them keeps running.

## Health options

The `health` section bounds the checkpoint that `GET /api/node/health` reports. The whole section is
optional.

| Option                            | Type                              | Default                                                  | Description                                                                                          |
| --------------------------------- | --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `health.checkpointIntervalMs`     | integer >= 1000                   | `60000`                                                  | Length of one checkpoint round                                                                       |
| `health.maxCheckpointAgeMs`       | integer >= `checkpointIntervalMs` | `checkpointIntervalMs * 3`                               | Age at which the last completed checkpoint becomes stale                                             |
| `health.storageMaxAgeMs`          | integer >= `checkpointIntervalMs` | `checkpointIntervalMs * 2`                               | Maximum age of the cached storage scan a checkpoint accepts                                          |
| `health.repairMaxAgeMs`           | integer >= `checkpointIntervalMs` | `3600000`                                                | Maximum age of a completed full repair sweep                                                         |
| `health.clockSkewToleranceMs`     | integer >= 0                      | `10000`                                                  | Allowed clock difference between two attesting peers                                                 |
| `health.peerAttestationTimeoutMs` | integer >= 1                      | `5000`                                                   | Bound for one peer attestation call                                                                  |
| `health.requiredPeerCount`        | integer >= 0                      | `1` when more than one node is configured, otherwise `0` | Configured remote peers that must attest a round                                                     |
| `health.repairBacklogGraceCycles` | integer >= 0                      | `0`                                                      | Consecutive complete unsuccessful repair cycles with backlog during which `repairFresh` remains true |

Three consequences worth planning for:

- With `requiredPeerCount: 0` the peer-attestation check always passes, and the checkpoint proves
  only this node's own prerequisites. Network coverage is then unverified.
- `repairMaxAgeMs` must be longer than the largest expected full repair cycle plus the repair
  schedule interval, or a node whose repair is still working through its records reports `degraded`
- `checkpointIntervalMs` also sets the recovery lag. A downgrade can happen at read time, but
  returning to `ready` needs a successful checkpoint.

The states and what each check means are described in [Monitoring](/operations/monitoring).

## Cross-field rules

Every rule below aborts startup. The message names the field that failed.

- `peerDiscovery.listen` must contain at least one multiaddr
- `logLevel` must be one of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`
- every `nodes[].multiAddr` must contain a `/p2p/<peer-id>` component, and no two entries may resolve
  to the same peer id
- `maxFileCount` must be an integer from 1 through 100
- `uploadLimitSizeBytes` must be a positive integer
- `cors.allowedOrigins` must be a non-empty array, and every entry must satisfy the rules in
  [CORS](#cors)
- `trustProxy` must not be `true`, `*`, `0.0.0.0/0`, or `::/0`
- `adminApiKey` must be empty or at least 32 characters, and must not be one of the known
  placeholders
- `downloadMaxDurationMs` must be greater than or equal to `downloadIdleTimeout`
- an explicitly set `downloadMaxDurationMs` must also cover
  `ceil(uploadLimitSizeBytes / downloadMinBytesPerSecond) * 1000 + downloadIdleTimeout`, so that the
  largest accepted file cannot be cut off mid-stream and reported as a retrieval timeout
- `storage.maxRequestSizeBytes` must be greater than or equal to `uploadLimitSizeBytes`, otherwise
  no single file could be uploaded
- `storage.maxConcurrentDownloadsPerClient` must not exceed `storage.maxConcurrentDownloads`
- `storage.gc.lowWatermarkBytes` must be lower than `storage.gc.highWatermarkBytes`
- `replication.placement` must be a non-empty array, and `placement[0].minAgeMs` must be `0` so every
  file matches a tier
- each later tier must have a strictly greater `minAgeMs` than the tier before it
- each later tier's `copies` must not exceed the tier before it, so copies shrink as a file ages
- `replication.ackQuorum` must not exceed the `copies` value of the fresh tier
- `replication.requireQuorumOnUpload: true` requires `replication.ackQuorum >= 2`, so a strict upload
  cannot succeed on the local copy alone
- `storage.confirmationRequired` and `replication.requireQuorumOnUpload` cannot both be `true`
- `health.requiredPeerCount` must not exceed the number of configured remote peers, which is counted
  as the number of `nodes` entries minus one
- `health.maxCheckpointAgeMs`, `health.storageMaxAgeMs`, and `health.repairMaxAgeMs` must each be at
  least `health.checkpointIntervalMs`

## Migrating an older configuration

Unknown keys are ignored, so a removed option does not fail startup. It also does nothing, which is
the risk: a file that still carries an old key looks configured and is not.

`autoPeeringPeriod` no longer exists. Replace it with `peeringSchedule`, which takes the same cron
form and redials the entries of `nodes` that are not connected. A file that keeps only
`autoPeeringPeriod` starts successfully and falls back to the `*/30 * * * * *` default.

`cors.origin` and `cors.originRegexps` are replaced by `cors.allowedOrigins`. Regular expressions
are no longer accepted. Rewrite each pattern as an exact origin or an any-depth subdomain wildcard:

```json5
// Before
cors: {
  origin: ['https://app.example.org'],
  originRegexps: ['^https://.*\\.example\\.org$']
}

// After
cors: {
  allowedOrigins: ['https://app.example.org', 'https://*.example.org']
}
```

Because `cors.allowedOrigins` is required, a file that carries only the old keys aborts at startup
rather than silently allowing nothing.

The detailed node response moved. `GET /api/node/info` is still public and still returns the version,
timestamp, Helia status, and megabyte disk figures. Peer id, listen multiaddrs, and the byte-accurate
storage report now come from `GET /api/node/details`, which requires `x-api-key`. A monitoring
integration that scraped identity fields from `/api/node/info` needs `adminApiKey` set and the header
added.

For `health.requiredPeerCount` during a staged rollout: a node cannot complete a checkpoint while
fewer than `requiredPeerCount` peers attest the round, so a node upgraded ahead of its peers reports
a frozen `height` and a state other than `ready`. Set `requiredPeerCount: 0` on the nodes you upgrade first,
then raise it once every peer answers on `/adamant/health/1.0.0`. Two related points:

- the bound is `nodes.length - 1`, so removing a peer from `nodes` may require lowering
  `requiredPeerCount` in the same change
- changing `nodes` changes the membership epoch and resets the persisted checkpoint, so `height`
  returns to `0` for the new epoch on every node

## Full example

A three-node deployment, shown from the perspective of the first node. Each node runs the same
`nodes` list, including its own entry, which is filtered out before dialling.

The peer ids and addresses below are placeholders and are not valid. Replace each one with the value
its node reports at `GET /api/node/details`, and use the reachable address of that node.

```json5
{
  // Same list on every node. Each multiaddr must end in /p2p/<peer-id>.
  nodes: [
    {
      name: 'node-a',
      multiAddr: '/ip4/198.51.100.11/tcp/4001/p2p/12D3KooWNodeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    {
      name: 'node-b',
      multiAddr: '/ip4/198.51.100.12/tcp/4001/p2p/12D3KooWNodeBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    },
    {
      name: 'node-c',
      multiAddr: '/ip4/198.51.100.13/tcp/4001/p2p/12D3KooWNodeCccccccccccccccccccccccccccccccccccccccc'
    }
  ],

  // Persistent state lives in $HOME/.adm-ipfs.
  storeFolder: '.adm-ipfs',
  logLevel: 'info',
  prettyLogs: false,

  peerDiscovery: {
    // Dialled once at startup; peeringSchedule keeps the mesh together after that.
    bootstrap: [
      '/ip4/198.51.100.11/tcp/4001/p2p/12D3KooWNodeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '/ip4/198.51.100.12/tcp/4001/p2p/12D3KooWNodeBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '/ip4/198.51.100.13/tcp/4001/p2p/12D3KooWNodeCccccccccccccccccccccccccccccccccccccccc'
    ],
    listen: ['/ip4/0.0.0.0/tcp/4001']
  },

  serverPort: 4000,
  diskUsageScanPeriod: '*/30 * * * * *',
  peeringSchedule: '*/30 * * * * *',

  uploadLimitSizeBytes: 268435456, // 256 MiB per file
  maxFileCount: 10,
  findFileTimeout: 20000,
  downloadIdleTimeout: 20000,
  downloadMinBytesPerSecond: 32768,
  downloadMaxDurationMs: 14400000,

  cors: {
    // Replace with the origins of your own application.
    allowedOrigins: ['https://app.example.org', 'https://*.example.org']
  },

  // Behind a reverse proxy, list the exact proxy addresses instead.
  trustProxy: false,

  rateLimits: {
    upload: { windowMs: 900000, limit: 10 },
    pin: { windowMs: 900000, limit: 10 },
    read: { windowMs: 60000, limit: 100 }
  },

  // Generate with: openssl rand -hex 32. Empty makes admin routes answer 503.
  adminApiKey: '',
  enableDebugApi: false,

  storage: {
    maxRequestSizeBytes: 536870912,
    maxConcurrentUploads: 32,
    maxConcurrentDownloads: 64,
    maxConcurrentDownloadsPerClient: 8,
    diskReserveBytes: 5368709120,
    confirmationRequired: false,
    temporaryTtlMs: 86400000,
    gc: {
      enabled: true,
      schedule: '0 */15 * * * *',
      highWatermarkBytes: 53687091200,
      lowWatermarkBytes: 42949672960
    }
  },

  replication: {
    enabled: true,
    // Three nodes cannot hold four copies, so the fresh tier is set to 3.
    placement: [
      { minAgeMs: 0, copies: 3 },
      { minAgeMs: 15552000000, copies: 2 }
    ],
    ackQuorum: 1,
    requireQuorumOnUpload: false,
    requestTimeoutMs: 30000,
    repairEnabled: true,
    repairSchedule: '0 */30 * * * *',
    repairBatchDelayMs: 1000,
    repairProbeConcurrency: 4
  },

  health: {
    checkpointIntervalMs: 60000,
    maxCheckpointAgeMs: 180000,
    storageMaxAgeMs: 120000,
    repairMaxAgeMs: 3600000,
    clockSkewToleranceMs: 10000,
    peerAttestationTimeoutMs: 5000,
    // At most nodes.length - 1, so 2 here.
    requiredPeerCount: 1
  }
}
```

With this file in place, follow [Quick start](/guide/quick-start) for a source installation or
[Docker](/guide/docker) for a container. If a node does not reach `ready`, see
[Troubleshooting](/operations/troubleshooting).
