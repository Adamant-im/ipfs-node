# ADAMANT IPFS Node

Self-hosted IPFS storage node for application file delivery, with bounded disk usage, deterministic
replication, repair, health checkpoints, and a REST API.

It is a standalone Node.js service: an in-process [Helia](https://helia.io) node and a
[libp2p](https://libp2p.io) host behind an Express REST API. It is not a wrapper around Kubo, it
does not expose a Kubo-compatible API, and it is not an IPFS gateway. A deployment is a set of nodes
that know each other by multiaddr and exchange blocks, replicas, and health attestations only with
each other.

- Documentation: <https://ipfs-node.docs.adamant.im>
- Source: <https://github.com/Adamant-im/ipfs-node>
- Releases: <https://github.com/Adamant-im/ipfs-node/releases>
- Container package: <https://github.com/Adamant-im/ipfs-node/pkgs/container/ipfs-node>
- API specification: [docs/openapi.yaml](docs/openapi.yaml)
- Storage and replication reference: [docs/storage-lifecycle.md](docs/storage-lifecycle.md)

## Features

- REST upload of multipart files and content-addressed download by CID
- Controlled peer mesh over TCP with Noise encryption and Yamux multiplexing; only `identify` and
  `ping` are registered
- Bounded storage lifecycle: disk reserve, aggregate request limits, temporary uploads with a TTL,
  and watermark-driven garbage collection
- Deterministic placement by rendezvous hashing over the configured peer set, with copy counts that
  shrink as a file ages
- Cross-node replication and a resumable repair cycle over a libp2p protocol authenticated by the
  handshake
- Network-aware health checkpoints with a monotonic height and an explicit membership epoch
- Per-endpoint rate limits and admission control on concurrent uploads and downloads
- Structured newline-delimited JSON logs with content identifiers, peer ids, and credentials scrubbed

## Adopters

[ADAMANT Messenger](https://adamant.im) runs this node in production for attachment delivery, and is
the reference deployment. It is one adopter, not the purpose of the project — see
[the adopter page](https://ipfs-node.docs.adamant.im/guide/adamant-messenger).

## Good fit

- Application-owned, content-addressed file delivery across a small or fixed set of mutually trusted
  storage nodes
- Privacy-conscious deployments that prefer a controlled peer mesh over public IPFS discovery and
  gateways
- Teams that need replication, repair, bounded local storage, health reporting, and a REST API
  without operating separate Kubo and IPFS Cluster control planes
- Messenger and media-attachment storage
- Self-hosted services that value predictable configuration and operational limits over the breadth
  of a full public IPFS implementation

Details: <https://ipfs-node.docs.adamant.im/guide/use-cases>

## Choose another solution when

- You need a general-purpose public IPFS node, public DHT participation, IPNS, a public gateway, or
  Kubo API compatibility
- The cluster is large, highly dynamic, or made of mutually untrusted operators
- End users must own their files and delete them with an authenticated request
- You need built-in egress accounting and monthly quotas
- Content must be reachable from the public IPFS network
- You need S3-compatible APIs, mature cloud IAM, lifecycle tiers, or managed global delivery

Comparison with Kubo, Kubo plus IPFS Cluster, a custom Helia application, managed pinning providers,
and object storage: <https://ipfs-node.docs.adamant.im/guide/comparison>

## Boundaries and limitations

Read this before choosing an architecture around the node.

- **No public IPFS participation.** There is no DHT, no IPNS, no public gateway, no mDNS, no circuit
  relay, no NAT traversal, and no public bootstrap list. Content uploaded here is announced nowhere,
  and a CID that exists only on the public network cannot be fetched here
- **No Kubo API.** Kubo clients and tooling do not work against this service
- **No end-user identity.** Upload and download are unauthenticated by design; the only credential
  is one administrative key. Uploader-signed deletion is open work
  ([#27](https://github.com/Adamant-im/ipfs-node/issues/27))
- **Static peer lists.** Every node must be listed on every other node, and changing that list
  resets the health checkpoint epoch. Peer discovery is open work
  ([#28](https://github.com/Adamant-im/ipfs-node/issues/28))
- **No traffic accounting.** Rate and concurrency limits exist; per-client byte accounting and
  monthly volume limits do not ([#29](https://github.com/Adamant-im/ipfs-node/issues/29))
- **No absolute data directory.** The store is always `$HOME/<storeFolder>`
  ([#30](https://github.com/Adamant-im/ipfs-node/issues/30))
- **Public-network interoperability is research**, not a feature
  ([#31](https://github.com/Adamant-im/ipfs-node/issues/31))

A controlled peer topology avoids the public DHT and public gateways and reduces public exposure of
content-routing metadata, but it does not by itself make a deployment private, anonymous, trustless,
or censorship-proof. Availability still depends on independent nodes, independent operators,
replication settings, and deployer choices.

## Requirements

- Node.js 24. The repository ships an `.nvmrc`, so `nvm use` selects it
- A TLS-terminating reverse proxy for every public deployment
- A unique administrative API key for operator endpoints

## Quick start from source

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
nvm use
npm ci
npm run build
node dist/index.js
```

`npm ci` must run install scripts. Helia depends on `@libp2p/webrtc`, whose `node-datachannel`
native module downloads a prebuilt binary from GitHub releases; installing with `--ignore-scripts`
produces a tree that fails at startup. See [Dependency notes](#dependency-notes).

Copy `config.default.json5` to `config.json5` before starting. **Its peer list points at the ADAMANT
production mesh**, so a deployment that is not joining ADAMANT must replace `nodes`,
`peerDiscovery.bootstrap`, and `cors.allowedOrigins`. Empty peer lists run a standalone node.

The process can also be managed with PM2:

```bash
npm install --global pm2
pm2 start dist/index.js --name="IPFS node"
```

Full guide: <https://ipfs-node.docs.adamant.im/guide/quick-start>

## Quick start with Docker

```bash
docker volume create ipfs-node-data

docker run -d \
  --name ipfs-node \
  --restart unless-stopped \
  --stop-timeout 20 \
  -v ipfs-node-data:/data \
  -v "$PWD/config.json5:/app/config.json5:ro" \
  -p 127.0.0.1:4000:4000 \
  -p 4001:4001 \
  ghcr.io/adamant-im/ipfs-node:<version>
```

Take `<version>` from the [releases page](https://github.com/Adamant-im/ipfs-node/releases): every
release publishes an immutable version tag, a stable release also moves `latest`, and a prerelease
publishes its version tag only.

The image ships no configuration; mount one at `/app/config.json5`. `HOME` is `/data`, so a single
`/data` volume holds the blockstore, datastore, peer identity, pin set, lifecycle registry, repair
cursor, and health checkpoint. `docker/config.example.json5` is a standalone starting point and
`docker/docker-compose.yml` is a minimal evaluation stack.

Full guide: <https://ipfs-node.docs.adamant.im/guide/docker>

## Configuration

Copy `config.default.json5` to `config.json5` and replace every deployment-specific value.

The config file is selected by the `IPFS_NODE_CONFIG` environment variable, or by the first CLI
argument when the variable is not set. Both select `config.<name>.json5`; with neither,
`config.json5` is used. `node dist/index.js test1` and `IPFS_NODE_CONFIG=test1 node dist/index.js`
are equivalent.

The whole configuration is validated at startup: a missing file, invalid JSON5, or a field with the
wrong type aborts the process with a message naming the offending field. `storage`, `replication`,
and `health` are optional and every option falls back to a documented default, so an existing
configuration file keeps working.

Generate the administrative secret before enabling operator endpoints:

```bash
openssl rand -hex 32
```

A missing or empty `adminApiKey` fails closed: administrative routes return
`503 Service not configured`. Known placeholder values and secrets shorter than 32 characters
prevent startup.

Every option, default, and cross-field rule, plus the migration notes for `autoPeeringPeriod`,
`cors.originRegexps`, and the `/api/node/info` to `/api/node/details` move:
<https://ipfs-node.docs.adamant.im/guide/configuration>

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

CORS is a browser control and is never treated as authentication.
`GET /api/helia/routing/findProviders/:cid` no longer exists: provider lookup requires content
routing, and this deployment intentionally runs none.

### Public upload decision

Upload remains public for compatibility with direct Messenger clients. The service has no safe
channel for distributing an upload secret and does not implement a short-lived signing protocol.
Public upload is constrained by per-client request limits, per-file size, per-request file count,
filename sanitization, and the deployment proxy.

This is an explicit compatibility decision, not an authorization guarantee. A deployment that
requires signed upload authorization must enforce it at a trusted gateway until a client-compatible
signing protocol is designed. Files of any content type are accepted, but downloads are served as
`application/octet-stream` attachments with content sniffing disabled.

The multipart contract accepts `files` parts only. Text fields are rejected with a controlled
`400 Bad Request`.

An interrupted upload leaves no blocks behind: each request owns a session that records the blocks
it created, and a rejected, aborted, or partially failed request removes exactly those. Blockstore
growth is bounded by the disk reserve, the aggregate request size, the concurrency limit, and the
collection watermarks.

Security, privacy, TLS, proxy, and exposure guidance:
<https://ipfs-node.docs.adamant.im/guide/security>

## Network topology

The node forms a controlled mesh with the peers listed in `nodes` and `peerDiscovery.bootstrap`.
libp2p is configured explicitly and the Helia defaults are not merged in, so the node runs:

- TCP transport only, with Noise encryption and Yamux stream multiplexing
- bootstrap peer discovery, restricted to the configured multiaddrs
- the `identify` and `ping` services only

There is no DHT, no mDNS discovery, no circuit relay, no NAT traversal, and no HTTP gateway routing.
Blocks are exchanged with known peers over bitswap, so block requests never leave the configured
peer set and no CID is disclosed to a public gateway.

The node is composed from `createHeliaLight`, `withLibp2pLight`, and `withBitswap` rather than
`createHelia`, because `createHelia` merges its default libp2p configuration into whatever is passed
in. Keeping it would silently add mDNS, the public IPFS bootstrap list, kad-DHT, AutoNAT, AutoTLS,
UPnP, circuit relay, and WebRTC/WebSocket transports.

The libp2p private key is stored in the datastore under `/pkcs8/self`, so a node keeps its peer
identity across restarts as long as its store directory is preserved.

Architecture, trust boundaries, and protocol detail:
<https://ipfs-node.docs.adamant.im/guide/architecture>

### TLS boundary

The Node.js process serves HTTP and does not terminate TLS. Bind it to a private interface or
firewall it so clients can reach it only through a correctly configured HTTPS reverse proxy. The
proxy must replace untrusted forwarding headers and forward requests to the configured `serverPort`.

Never expose the application port directly to the internet.

### Dependency audit policy

```bash
npm run security:audit
npm run security:semgrep
```

The audit fails on every high or critical production advisory. There are no accepted exceptions.
Use `npm run security:audit:raw` to inspect the unfiltered npm result.

## Dependency notes

`helia` depends on `@helia/libp2p`, which depends on `@libp2p/webrtc` even though WebRTC is never
configured here. That pulls two things into the tree:

- `node-datachannel`, a native module whose prebuilt binary is downloaded from GitHub releases
  during `npm install`. An installer that reaches the npm registry but not GitHub releases produces
  a tree that fails at startup, so `--ignore-scripts` is suitable only for auditing and for building
  the documentation site, not for running or testing
- `react-native-webrtc`, and through it `react-native` and its Metro bundler, in the development
  tree only

`npm run security:audit` scopes the audit with `--omit=dev --omit=peer` and reports no findings.
Running a bare `npm audit --omit=dev` additionally surfaces advisories against Metro and its
`image-size` dependency; Metro is a React Native build tool that this service never loads. Re-check
these when Helia is upgraded.

## API

The stable client, lifecycle, and node-health contract is
[OpenAPI 3.1](docs/openapi.yaml). Worked examples, status-code tables, and the generated endpoint
reference are on the documentation site:

- <https://ipfs-node.docs.adamant.im/reference/api>
- <https://ipfs-node.docs.adamant.im/reference/endpoints>

`GET /api/node/health` always returns `200`; consumers must inspect `state`, which is `starting`,
`ready`, `stale`, or `degraded`. `height` is a persisted, monotonic checkpoint that advances only
when every prerequisite passes and freezes on failure, and it is comparable between nodes only when
their `membership.version` matches. Health semantics and alerting:
<https://ipfs-node.docs.adamant.im/operations/monitoring>

## Development

```bash
npm run dev
npm run lint
npm run format
npm run typecheck
npm test
```

`npm test` compiles `src` and `test` to `dist-test` and then runs the unit and integration suites
with Node's built-in test runner against `config.test.json5`, which has no bootstrap peers and
listens on loopback with an OS-assigned port.

Three TypeScript configurations share one set of compiler options:

| File                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `tsconfig.json`       | Type-checks `src` and `test`. Emits nothing; this is what editors use |
| `tsconfig.build.json` | Builds `src` into `dist` for `npm run build`                          |
| `tsconfig.test.json`  | Builds `src` and `test` into `dist-test` for `npm test`               |

Pass no file arguments to `tsc`. Naming a file on the command line makes TypeScript ignore
`tsconfig.json` entirely, so `outDir` is not applied and the project's `lib`, `module`, and
`moduleResolution` settings are replaced by defaults.

The documentation site is built from `docs/`:

```bash
npm run docs:dev
npm run docs:build
```

`docs/reference/endpoints.md` and `docs/public/openapi.yaml` are generated from `docs/openapi.yaml`
and must not be edited by hand. The build fails on a broken internal link, a missing generated API
reference, or a missing custom-domain file.

## Validation

```bash
npm ci
npm run build
npm run lint
npm run format
npm run typecheck
npm test
npm run docs:build
npm run security:audit
npm run security:semgrep
git diff --check
```

To exercise the container:

```bash
docker build -t ipfs-node:local .
./scripts/docker-smoke-test.sh ipfs-node:local
```

## Documentation

- [What it is](https://ipfs-node.docs.adamant.im/guide/what-is-it)
- [Use cases](https://ipfs-node.docs.adamant.im/guide/use-cases) and
  [Comparison](https://ipfs-node.docs.adamant.im/guide/comparison)
- [Architecture](https://ipfs-node.docs.adamant.im/guide/architecture)
- [Quick start](https://ipfs-node.docs.adamant.im/guide/quick-start),
  [Docker](https://ipfs-node.docs.adamant.im/guide/docker),
  [Installation](https://ipfs-node.docs.adamant.im/guide/installation)
- [Configuration](https://ipfs-node.docs.adamant.im/guide/configuration) and
  [Security and privacy](https://ipfs-node.docs.adamant.im/guide/security)
- [API overview](https://ipfs-node.docs.adamant.im/reference/api) and
  [Endpoint reference](https://ipfs-node.docs.adamant.im/reference/endpoints)
- Operations:
  [monitoring](https://ipfs-node.docs.adamant.im/operations/monitoring),
  [persistence](https://ipfs-node.docs.adamant.im/operations/persistence),
  [upgrades](https://ipfs-node.docs.adamant.im/operations/upgrades),
  [troubleshooting](https://ipfs-node.docs.adamant.im/operations/troubleshooting)
- In this repository: [docs/openapi.yaml](docs/openapi.yaml),
  [docs/storage-lifecycle.md](docs/storage-lifecycle.md), [AGENTS.md](AGENTS.md)

## Contributing

Issues and pull requests are welcome. Conventions, checks, and the documentation workflow are in
[AGENTS.md](AGENTS.md) and on
[the contributing page](https://ipfs-node.docs.adamant.im/guide/contributing). Report suspected
vulnerabilities privately through GitHub security advisories rather than in a public issue.

## License

[GPL-3.0](LICENSE). Copyright (c) ADAMANT Foundation and contributors.
