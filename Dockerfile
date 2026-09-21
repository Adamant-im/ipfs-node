# Production image for ADAMANT IPFS Node.
#
# No `# syntax=` directive on purpose: this file uses no feature beyond the
# built-in BuildKit frontend, and resolving an external frontend image makes
# every build depend on a registry round trip.
#
# The base is Debian bookworm. Helia pulls @libp2p/webrtc, whose
# node-datachannel native module downloads a prebuilt binary during install;
# glibc is the combination this image is built and smoke-tested on. Alpine is
# not offered — musl prebuilds exist upstream, but nothing here has validated
# that runtime, and an untested base is not a supported one.
#
# Persistent state lives under HOME. `storeFolder` in the configuration file is
# resolved from the home directory of the process user (src/store.ts), so the
# image pins HOME to /data and a single /data volume holds the blockstore, the
# datastore, the libp2p peer identity, the pin set, the lifecycle registry, the
# repair cursor, and the health checkpoint. See Adamant-im/ipfs-node#30 for the
# planned absolute `dataDir` option.

ARG NODE_IMAGE=node:24.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS build

WORKDIR /app

# Install scripts must run: @libp2p/webrtc pulls node-datachannel, whose binary
# is downloaded here. package.json allowScripts permits that download; .npmrc
# fails the build if a new unreviewed install script appears. A tree installed
# with --ignore-scripts fails at startup.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --omit=peer \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

# Populated by the release workflow from the Git tag and commit.
ARG IMAGE_VERSION=0.0.0-dev
ARG IMAGE_REVISION=unknown
ARG IMAGE_CREATED=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="ADAMANT IPFS Node" \
  org.opencontainers.image.description="Self-hosted IPFS storage node for application file delivery, with bounded disk usage, deterministic replication, repair, health checkpoints, and a REST API" \
  org.opencontainers.image.source="https://github.com/Adamant-im/ipfs-node" \
  org.opencontainers.image.url="https://github.com/Adamant-im/ipfs-node" \
  org.opencontainers.image.documentation="https://ipfs-node.docs.adamant.im" \
  org.opencontainers.image.licenses="GPL-3.0" \
  org.opencontainers.image.vendor="ADAMANT Developer Community" \
  org.opencontainers.image.authors="ADAMANT Developer Community <devs@adamant.im>" \
  org.opencontainers.image.version="${IMAGE_VERSION}" \
  org.opencontainers.image.revision="${IMAGE_REVISION}" \
  org.opencontainers.image.created="${IMAGE_CREATED}"

ENV NODE_ENV=production \
  HOME=/data

WORKDIR /app

# The image ships no configuration. `config.json5` is mounted at runtime so that
# peer lists, the administrative key, and every other deployment value stay out
# of the image layers. config.default.json5 is copied as a documented template
# only; it is never selected automatically, because its peer list points at the
# ADAMANT production mesh.
COPY --chown=root:root package.json ./package.json
COPY --chown=root:root config.default.json5 ./config.default.json5
COPY --chown=root:root docker/healthcheck.mjs ./docker/healthcheck.mjs
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist

# `node` (uid 1000) already exists in the base image. /data is its home and the
# only path the process writes to, so the rest of the filesystem stays read-only
# for the runtime user.
RUN mkdir -p /data && chown -R node:node /data

USER node

VOLUME ["/data"]

# 4000 serves the HTTP API, 4001 is the libp2p listener from
# `peerDiscovery.listen`. Both are published by the operator; TLS termination
# and any reverse proxy stay outside the image.
EXPOSE 4000 4001

# Liveness is the process being alive; readiness is the documented health state.
# GET /api/node/health always answers 200 and reports the state in JSON, so the
# check parses the body instead of trusting the status code. Startup
# reconciliation, the first disk scan, and the first checkpoint have to complete
# before a node reports "ready", which is what the start period covers.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

# Node handles SIGTERM itself (src/index.ts), so it can run as PID 1 without an
# init shim. Shutdown closes the HTTP server, stops the background jobs, and
# stops Helia, with a 15 s internal deadline; give the container at least 20 s.
STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
