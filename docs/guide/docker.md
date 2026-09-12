---
title: Docker
description: Run the ADAMANT IPFS node as a container with mounted configuration, one persistent volume, health checks, and a graceful stop.
---

# Docker

The container runs the same service as a source installation: one Node.js process that embeds
Helia and libp2p and serves the REST API. Configuration and persistent state stay outside the
image, so the container is replaceable while the node keeps its peer identity and its content.

## Image

| Property          | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| Repository        | `ghcr.io/adamant-im/ipfs-node`                           |
| Base image        | `node:24.13.0-bookworm-slim`                             |
| Architectures     | `linux/amd64`, `linux/arm64`                             |
| Runtime user      | `node`, uid 1000                                         |
| Working directory | `/app`                                                   |
| Persistent path   | `/data`, declared as a volume, with `HOME=/data`         |
| Configuration     | mounted at `/app/config.json5`, not shipped in the image |
| Exposed ports     | `4000` HTTP API, `4001` libp2p                           |
| Command           | `node dist/index.js`                                     |
| Stop signal       | `SIGTERM`                                                |

The base is Debian bookworm slim on the Node.js 24 line rather than Alpine. Helia pulls
`@libp2p/webrtc`, whose `node-datachannel` native module downloads a prebuilt binary during
install, and glibc is the combination this image is built and smoke-tested on. Alpine is not
offered: musl prebuilds exist upstream, but nothing in this repository has validated that runtime.

The build is multi-stage. The build stage runs `npm ci`, `npm run build`, then
`npm prune --omit=dev --omit=peer`; the runtime stage copies only `package.json`,
`config.default.json5`, `docker/healthcheck.mjs`, the pruned `node_modules`, and `dist`. The
unprivileged `node` user already exists in the base image, `/data` is its home, and it is the only
path the process writes to.

Tags come from GitHub Releases, and nothing is published from a branch push:

- every release publishes an immutable version tag
- a stable release also moves `latest`
- a prerelease publishes its version tag only, so `latest` never points at a prerelease

```bash
docker pull ghcr.io/adamant-im/ipfs-node:<version>
```

No release has been published yet. Take the exact value for `<version>` from the
[releases page](https://github.com/Adamant-im/ipfs-node/releases), or from the
[package page](https://github.com/Adamant-im/ipfs-node/pkgs/container/ipfs-node), and pin a version
tag or a digest in production rather than tracking `latest`.

## Quick start with Compose

`docker/docker-compose.yml` is a minimal stack for evaluating the node locally.

```bash
cd docker
cp config.example.json5 config.json5
docker compose up --build
```

Edit `config.json5` before running anything that matters. The example joins no network: `nodes` and
`peerDiscovery.bootstrap` are empty, so the node peers with nobody and keeps a single local copy of
everything it accepts. `adminApiKey` is empty as well, which makes administrative routes answer
`503`.

The stack builds the image from the checkout by default. Set `IPFS_NODE_IMAGE` to run a published
image instead:

```bash
IPFS_NODE_IMAGE=ghcr.io/adamant-im/ipfs-node:<version> docker compose up
```

What the file sets, and why:

- `stop_grace_period: 20s`, because the process has a 15 s internal shutdown deadline
- `ports: 127.0.0.1:4000:4000` for the API and `4001:4001` for the libp2p listener
- `volumes: ipfs-node-data:/data` for all persistent state, and `./config.json5:/app/config.json5:ro`
  for the configuration
- `healthcheck` repeating the image defaults, so the knobs are visible in one place
- `security_opt: no-new-privileges:true` on top of the unprivileged runtime user
- `restart: unless-stopped`

Read the node state once the container is up:

```bash
curl -s http://127.0.0.1:4000/api/node/health
```

## Quick start with docker run

```bash
docker volume create ipfs-node-data

docker run -d \
  --name ipfs-node \
  --restart unless-stopped \
  --stop-timeout 20 \
  --security-opt no-new-privileges:true \
  -v ipfs-node-data:/data \
  -v "$PWD/config.json5:/app/config.json5:ro" \
  -p 127.0.0.1:4000:4000 \
  -p 4001:4001 \
  ghcr.io/adamant-im/ipfs-node:<version>
```

`--stop-timeout 20` makes a later `docker stop` wait long enough for the graceful shutdown path.
`docker/config.example.json5` is a usable starting point for `config.json5`: copy it out of the
repository and edit it before the first start.

## Configuration

The image ships no `config.json5`. Every deployment value — peer list, administrative key, limits,
CORS origins — is mounted at runtime, so nothing deployment-specific ends up in an image layer or
in `docker history`.

- Mount the file read-only at `/app/config.json5`. The process locates its configuration by walking
  up from the compiled entry point to the nearest `package.json`, which is `/app` in the container
- `config.default.json5` is copied into the image as a documented template only. It is never
  selected automatically, and its peer list points at the ADAMANT production mesh, so another
  deployment must not use it as-is
- `IPFS_NODE_CONFIG` selects `config.<name>.json5`; otherwise the first command-line argument is
  used, and otherwise `config.json5`
- Configuration is read once at startup, so recreate or restart the container after editing the file
- The build context excludes `config.json5` and `config.*.json5`, along with `.git`, `node_modules`,
  `dist`, `logs`, `docs`, `test`, and the state directories

To run a named configuration:

```bash
docker run -d \
  --name ipfs-node \
  -e IPFS_NODE_CONFIG=production \
  -v "$PWD/config.production.json5:/app/config.production.json5:ro" \
  -v ipfs-node-data:/data \
  -p 127.0.0.1:4000:4000 \
  -p 4001:4001 \
  ghcr.io/adamant-im/ipfs-node:<version>
```

Validation aborts the process and names the offending field, so a container that exits immediately
after start is usually a configuration error; read `docker logs`. Every option is described in
[Configuration](/guide/configuration).

## Persistent data

`HOME` is `/data` in the image, and `storeFolder` is resolved from the home directory of the process
user. With the default `storeFolder: '.adm-ipfs'` the store is `/data/.adm-ipfs`, which holds:

- `blockstore/` with the content blocks
- `datastore/` with the libp2p peer identity, the pin set, the file lifecycle registry, the
  pin-intent markers, the repair cycle cursor, and the health checkpoint

One `/data` volume is therefore the entire durable state of the node. Replacing the container while
keeping the volume keeps the identity, the pins, and the content.

A named volume is initialized from the image, where `/data` is owned by uid 1000, so ownership is
correct without an extra step. A host bind mount is not: create the directory and give it to uid
1000 before the first start, or the process cannot write its stores.

```bash
sudo mkdir -p /srv/ipfs-node/data
sudo chown -R 1000:1000 /srv/ipfs-node/data
```

Losing the volume is not recoverable from the image. The node generates a new libp2p peer identity,
which changes the multiaddr other operators have configured for it, and content it used to serve
appears missing — a request for such a CID ends in a `408` timeout rather than a `404`, because the
node cannot know whether the content exists elsewhere.

An optional absolute `dataDir` that would decouple the store path from `HOME` is open work in
[issue #30](https://github.com/Adamant-im/ipfs-node/issues/30) and is not implemented. Backup and
restore procedures are in [Persistence](/operations/persistence).

## Ports and exposure

| Port   | Purpose                                  | Configured by          |
| ------ | ---------------------------------------- | ---------------------- |
| `4000` | HTTP REST API                            | `serverPort`           |
| `4001` | libp2p TCP listener for peer connections | `peerDiscovery.listen` |

Both ports are declared with `EXPOSE`; publishing them is the operator's decision.

- Bind port 4000 to loopback and put a TLS-terminating reverse proxy in front of it. The image
  contains no TLS, the process serves plain HTTP, and it logs a warning about that at startup
- Port 4001 has to be reachable by every peer listed in `nodes`, otherwise replication and health
  attestations cannot be exchanged
- Upload and download routes are public by design, and rate limits and size limits are the only
  admission control on them. A deployment that needs authorized uploads has to enforce that in front
  of the node
- The controlled peer topology avoids the public DHT and public gateways and reduces public exposure
  of content-routing metadata. It does not by itself make a deployment private, anonymous,
  trustless, or censorship-proof

Reverse proxy settings, `trustProxy`, CORS, and administrative key handling are covered in
[Security](/guide/security).

## Health checks

`GET /api/node/health` always answers HTTP `200` and reports the node state in the JSON body. A
check that only looked at the status code would call a `degraded` or a `stale` node healthy, so the
bundled check parses the body and compares the `state` field.

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]
```

The start period covers startup reconciliation, the first disk usage scan, and the first health
checkpoint, all of which have to complete before a node reports `ready`. The script exits `0` when
the state is accepted and `1` otherwise, printing the failing prerequisite checks from the response
so `docker inspect` shows why a container is unhealthy.

| Variable                           | Default                                                        | Effect                                    |
| ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `IPFS_NODE_HEALTHCHECK_URL`        | `http://127.0.0.1:$IPFS_NODE_HEALTHCHECK_PORT/api/node/health` | Full URL to probe                         |
| `IPFS_NODE_HEALTHCHECK_PORT`       | `4000`                                                         | API port used when no URL is given        |
| `IPFS_NODE_HEALTHCHECK_STATES`     | `ready`                                                        | Comma-separated states treated as healthy |
| `IPFS_NODE_HEALTHCHECK_TIMEOUT_MS` | `5000`                                                         | Request timeout in milliseconds           |

Set `IPFS_NODE_HEALTHCHECK_STATES=ready,degraded` only when a deployment deliberately accepts a node
whose prerequisites currently fail.

Liveness and readiness are different questions here:

- liveness is the process running; a node that answers the endpoint at all is alive
- readiness is the `state` field, one of `starting`, `ready`, `stale`, or `degraded`

Restart decisions belong to liveness, and traffic decisions belong to the state. Recovery from
`degraded` or `stale` back to `ready` requires a successful checkpoint, so expect up to
`health.checkpointIntervalMs` of lag before a recovered node reports `ready` again. The full health
contract is described in [Monitoring](/operations/monitoring).

## Graceful shutdown

`STOPSIGNAL` is `SIGTERM`, and the process handles `SIGTERM` and `SIGINT` itself, so it runs as PID
1 without an init shim.

On receipt the node logs `Received SIGTERM, shutting down`, stops the disk usage, peering, garbage
collection, and admission recovery jobs, stops replication repair and the health service, closes the
HTTP server, stops Helia, and exits with code `0`. Idle connections are force-closed after 12 s, and
a hard deadline of 15 s logs `Shutdown timed out` and exits with code `1`.

A stop timeout shorter than that deadline risks killing the process while it is still writing
persistent state, so give the container at least 20 s.

```bash
docker stop --timeout 20 ipfs-node
```

With Compose the same budget is `stop_grace_period: 20s`; with `docker run` it is
`--stop-timeout 20`, which becomes the default for a later `docker stop`.

## Image provenance

The runtime stage sets the OCI labels `title`, `description`, `source`, `url`, `documentation`,
`licenses`, `vendor`, `authors`, `version`, `revision`, and `created`. The last three come from
build arguments, which the release workflow fills from the release version, the commit SHA, and the
release publication time.

```bash
docker image inspect ghcr.io/adamant-im/ipfs-node:<version> --format '{{ json .Config.Labels }}'
```

Publication is tied to a GitHub Release. The release job checks that the tag is an ancestor of `dev`
and that it matches the version in `package.json` before building, and it pushes `linux/amd64` and
`linux/arm64` in one manifest. Release builds also attach an SBOM and a provenance attestation to
the image in the registry, so the published artifact carries its dependency inventory and its build
metadata alongside it. After publication the same runtime checks are run again against the pulled
image, once per architecture.

## Building the image yourself

```bash
docker build -t ipfs-node:local .
```

The build needs network access, and install scripts must run: `node-datachannel` downloads its
prebuilt binary during `npm ci`, and a tree installed with `--ignore-scripts` fails at startup.

| Build argument   | Default                      | Purpose                                   |
| ---------------- | ---------------------------- | ----------------------------------------- |
| `NODE_IMAGE`     | `node:24.13.0-bookworm-slim` | Base image for both stages                |
| `IMAGE_VERSION`  | `0.0.0-dev`                  | `org.opencontainers.image.version` label  |
| `IMAGE_REVISION` | `unknown`                    | `org.opencontainers.image.revision` label |
| `IMAGE_CREATED`  | `1970-01-01T00:00:00Z`       | `org.opencontainers.image.created` label  |

Stamping a local build with real metadata:

```bash
docker build \
  --build-arg IMAGE_VERSION="$(node -p "require('./package.json').version")" \
  --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" \
  -t ipfs-node:local .
```

Both published architectures with Buildx:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg IMAGE_VERSION=0.0.0-dev \
  --build-arg IMAGE_REVISION="$(git rev-parse HEAD)" \
  -t ipfs-node:local .
```

A multi-platform result cannot be loaded into the classic Docker image store. Push it to a registry,
or build one platform at a time with `--platform linux/arm64 --load` when the image has to stay
local.

## Verification

`scripts/docker-smoke-test.sh` exercises an image the way this page says it should be run:
configuration mounted at `/app/config.json5`, state on a single `/data` volume, an unprivileged
user, and readiness taken from the JSON health state. It needs `docker`, `curl`, and `node`, and it
removes the container, the volume, and its temporary directory on exit.

```bash
./scripts/docker-smoke-test.sh ipfs-node:local
```

An optional second argument pins the platform, which is how a published multi-architecture image is
checked:

```bash
./scripts/docker-smoke-test.sh ghcr.io/adamant-im/ipfs-node:<version> linux/arm64
```

The nine steps verify that the image:

1. starts from a mounted configuration and does not run as root
2. reports a documented health state
3. reaches `ready` with a non-zero checkpoint height
4. agrees with its own bundled health check
5. accepts a multipart upload, returns identical bytes on download, reports the file as `confirmed`,
   and answers the authenticated `GET /api/node/details` with a peer id
6. shuts down on `SIGTERM` with exit code `0` and the expected log line
7. keeps its content and its libp2p peer identity when the container is replaced on the same volume
8. applies a changed `maxFileCount` from the mounted file without a rebuild, visible in
   `GET /api/storage/policy`
9. carries the administrative key in no layer, history entry, or metadata field, and ships no
   `/app/config.json5` of its own

The same script runs in CI on both architectures for changes to the Dockerfile, the `docker/`
directory, `src/`, or the dependency lockfile, and again against the published image after a
release.
