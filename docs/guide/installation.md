---
title: Installation from source
description: Install, build, and run the ADAMANT IPFS node from a source checkout with PM2 or systemd behind a TLS-terminating reverse proxy.
---

# Installation from source

This page describes a source installation on a host you control: clone, build, configure, and run
the compiled entry point under a process manager behind a reverse proxy. The container image is
documented in [Docker](/guide/docker), and a first local run in
[Quick start](/guide/quick-start).

The project is distributed as source and as a container image. `package.json` is `private: true`
and nothing is published to npm, so there is no global package to install and no `npx` invocation.

## Requirements

| Requirement  | Detail                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| Node.js      | Version 24. `.nvmrc` contains `24` and `engines.node` is `>=24.0.0`        |
| Git and npm  | `npm ci` installs from `package-lock.json` and must reach GitHub releases  |
| Filesystem   | A POSIX filesystem for the store directory `$HOME/<storeFolder>`           |
| Inbound TCP  | The libp2p listen port, `4001` in the shipped examples                     |
| Outbound TCP | To every peer multiaddr in `nodes` and `peerDiscovery.bootstrap`           |
| HTTP port    | `serverPort`, `4000` in the shipped examples, bound to a private interface |
| TLS          | A TLS-terminating reverse proxy in front of `serverPort`                   |

The repository ships an `.nvmrc`, so `nvm use` inside the checkout selects the supported Node.js
line. Match it before installing; `npm ci` on an older runtime is not supported by `engines`.

The blockstore and the datastore are plain directory trees written by `blockstore-fs` and
`datastore-fs`. Both live under the home directory of the process user: `blockstorePath` is
`$HOME/<storeFolder>/blockstore` and `datastorePath` is `$HOME/<storeFolder>/datastore`, with
`storeFolder` defaulting to `.adm-ipfs` in the shipped configuration. The parent path is the home
directory of the process user, not a configuration option; an optional absolute `dataDir` is
tracked as [issue #30](https://github.com/Adamant-im/ipfs-node/issues/30) and is not implemented. Decide which home directory the service user has
before the first start, because moving the store later moves the peer identity with it.

libp2p listens on the multiaddrs in `peerDiscovery.listen`, `/ip4/0.0.0.0/tcp/4001` in the shipped
examples. Peers dial that address directly: the node runs TCP only, with no NAT traversal, no
circuit relay, no AutoNAT, and no UPnP, so a host behind NAT needs an explicit port forward for
inbound connections. Outbound TCP is needed to every address listed in `nodes` and
`peerDiscovery.bootstrap`.

Blocks are exchanged only with the configured peer set. That avoids the public DHT and public
gateways and reduces public exposure of content-routing metadata, but it does not by itself make a
deployment private, anonymous, trustless, or censorship-proof; see
[Security and privacy](/guide/security).

## Install from source

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
nvm install
nvm use
npm ci
npm run build
```

`nvm install` with no argument reads `.nvmrc` from the current directory, so run it from inside the
checkout. `npm run build` removes `dist` and compiles `src` with `tsconfig.build.json`; the entry
point is `dist/index.js`.

Create a configuration file before the first start:

```bash
cp config.default.json5 config.json5
```

`config.default.json5` is a template, not a starting point for a new deployment: its `nodes` and
`peerDiscovery.bootstrap` entries point at the ADAMANT production mesh. Replace them with the peers
of your own deployment, or leave both empty for a single node, and review every other value in
[Configuration](/guide/configuration) before serving traffic.

Then start the process:

```bash
node dist/index.js
```

The first log line names the configuration file that was read. The process also logs the HTTP port,
a warning that TLS is not handled at the application level, and a warning while `trustProxy` is
`false`.

`npm ci` must run install scripts. `helia` depends on `@helia/libp2p`, which depends on
`@libp2p/webrtc`, whose `node-datachannel` native module downloads a prebuilt binary from GitHub
releases during installation. Installing with `--ignore-scripts` produces a tree that fails at
startup, and an installer that reaches the npm registry but not GitHub releases fails the same way.

`--ignore-scripts` is useful for two things and nothing else:

- auditing the dependency tree without executing package code
- building the documentation site, which never loads the runtime node

It is not suitable for running the service, for `npm test`, or for producing a deployable tree.

## Dependency notes

`helia` depends on `@helia/libp2p`, which depends on `@libp2p/webrtc` even though WebRTC is never
configured here. That pulls two things into the tree:

- `node-datachannel`, a native module whose prebuilt binary is downloaded from GitHub releases
  during `npm install`. Upstream publishes both glibc and musl builds, but glibc is the one this
  project is tested on.
- `react-native-webrtc`, and through it `react-native` and its Metro bundler, in the development
  tree only

`npm run security:audit` runs `scripts/audit-production.mjs`, which calls
`npm audit --omit=dev --omit=peer --json` and fails on any high or critical advisory in the
production dependency set. `npm run security:audit:raw` runs npm's own reporter with the same
omissions at `--audit-level=high`.

A bare `npm audit --omit=dev` uses a wider scope and additionally surfaces advisories against Metro
and its `image-size` dependency. Metro is a React Native build tool that this service never loads,
which is why the repository policy omits peer dependencies. Re-check these when Helia is upgraded.

```bash
npm run security:audit
npm run security:semgrep
```

## Choosing a configuration file

Configuration is a JSON5 file read from the repository root. The root is located by walking up from
the compiled entry point to the nearest `package.json`, so the file sits next to `package.json`,
not next to `dist/`, and the working directory of the process does not affect which file is found.

The file name comes from `IPFS_NODE_CONFIG` when that variable is set, otherwise from the first CLI
argument, otherwise from the default. Both forms select `config.<name>.json5`.

| Invocation                                    | File read            |
| --------------------------------------------- | -------------------- |
| `node dist/index.js`                          | `config.json5`       |
| `node dist/index.js test1`                    | `config.test1.json5` |
| `IPFS_NODE_CONFIG=test1 node dist/index.js`   | `config.test1.json5` |
| `IPFS_NODE_CONFIG=test1 node dist/index.js x` | `config.test1.json5` |

The environment variable wins over the argument so that the configuration can still be selected
when the process is started by a tool that owns the argument list. Use it with `npm start`, with
PM2, and in a systemd unit. `npm test` uses the same mechanism and runs against `config.test.json5`.

The whole file is validated at startup. A missing file, invalid JSON5, or a field with the wrong
type aborts the process with a message naming the offending field; unknown keys are ignored. The
first log line reports the selected file, which is the fastest way to confirm that a service manager
passed the environment you expected.

## Running as a service

Both examples below run `dist/index.js` from the checkout, with the configuration file in the
repository root next to `package.json`.

PM2:

```bash
npm install --global pm2
pm2 start dist/index.js --name="IPFS node"
```

Pass a non-default configuration through the environment, for example
`IPFS_NODE_CONFIG=prod pm2 start dist/index.js --name="IPFS node"`. Use `pm2 save` and
`pm2 startup` if the process should come back after a reboot.

A minimal systemd unit at `/etc/systemd/system/ipfs-node.service`:

```ini
[Unit]
Description=ADAMANT IPFS node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ipfs-node
Group=ipfs-node
WorkingDirectory=/opt/ipfs-node
Environment=HOME=/var/lib/ipfs-node
ExecStart=/usr/local/bin/node dist/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Notes on the unit:

- Run the service as a dedicated unprivileged account. Create `ipfs-node`, give it
  `/var/lib/ipfs-node` as its home, and make it the owner of both that directory and the checkout.
- `Environment=HOME=` decides where the store goes. `storeFolder` is resolved from the home
  directory of the process user, so with the shipped value the store is
  `/var/lib/ipfs-node/.adm-ipfs`.
- `WorkingDirectory=` is what makes the relative `dist/index.js` in `ExecStart=` resolve. Point it
  at the checkout.
- Replace `/usr/local/bin/node` with the absolute path of the Node.js 24 binary. systemd reads no
  shell profile, so an nvm-managed `node` is not on the unit's `PATH`; run `command -v node` in a
  shell where `nvm use` has selected the right line and use that path.
- `TimeoutStopSec=30` leaves room for the shutdown sequence described below. Anything under 20
  seconds risks `SIGKILL` while persistent state is still being written.
- `Restart=on-failure` restarts after a crash and after a shutdown that exceeded its own deadline
  and exited with code `1`, and leaves a clean stop alone

On `SIGTERM` the process stops the disk-usage, peering, garbage-collection, and admission-recovery
jobs, stops replication repair and the health service, closes the HTTP server, stops Helia, and
exits. Idle connections are force-closed 12 seconds in, and a hard internal deadline of 15 seconds
logs `Shutdown timed out` and exits with code `1`. A stop timeout below 20 seconds cuts that
sequence short.

Logs are newline-delimited JSON from Pino on stdout, which journald captures as it stands. Keep
`prettyLogs: false` outside an interactive terminal so the structured fields survive.

## Reverse proxy

The Node.js process serves plain HTTP and never terminates TLS. Bind `serverPort` to a private
interface or firewall it, and let every client reach it through an HTTPS reverse proxy. The
application port must never be exposed to the internet directly.

An nginx server block for the shipped ports:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name ipfs.example.org;

  ssl_certificate /etc/letsencrypt/live/ipfs.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ipfs.example.org/privkey.pem;

  # At or below uploadLimitSizeBytes; 256m matches the shipped 268435456.
  client_max_body_size 256m;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    # Overwrite, never append: a client-supplied X-Forwarded-For must not survive.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Stream uploads straight through instead of spooling the whole body first.
    proxy_request_buffering off;
    # Stream downloads back as they are produced.
    proxy_buffering off;

    # Applies between two successive reads, not to the whole transfer. Keep it
    # above downloadIdleTimeout so a stalled transfer ends on the node's own
    # deadline and returns its documented status.
    proxy_read_timeout 120s;
  }
}
```

The proxy must overwrite untrusted forwarding headers. `$proxy_add_x_forwarded_for` appends to
whatever the client sent, so at an internet-facing edge use `$remote_addr`; the appending form is
correct only when the hop in front of nginx is itself trusted and sanitizing.

Overwriting is only half of it: `trustProxy` has to list the proxy addresses, otherwise Express
keeps using the socket address and every client shares the proxy's identity and rate-limit bucket.
The process logs a startup warning while the value is `false`. Configure exact addresses or CIDR
ranges:

```json5
trustProxy: ['127.0.0.1/8', '::1/128']
```

A numeric hop count is accepted only for a fixed topology where every path to the application
crosses exactly that many trusted hops. The blanket value `true` is rejected, because a client
could then spoof `X-Forwarded-For` whenever the last proxy does not overwrite it.

`client_max_body_size` bounds one request at the edge; the node independently rejects a single file
over `uploadLimitSizeBytes` and a combined request over `storage.maxRequestSizeBytes`. Keep the
proxy limit at or below `uploadLimitSizeBytes` so oversized bodies are refused before they reach the
process.

Application rate limiters are in-memory counters per process, so the proxy must also enforce request
rates, connection limits, and header limits for any multi-process or distributed deployment. The
full boundary, including the administrative key rules, is described in
[Security and privacy](/guide/security).

## Upgrading

An upgrade is a `git` update, a fresh `npm ci`, a rebuild, and a restart. The store directory is not
touched, so the peer identity, the blockstore, the pin set, the lifecycle registry, and the health
checkpoint survive; no store migration is required.

Read [Upgrades and rollback](/operations/upgrades) for the procedure, the order to follow across a
mesh, and how to roll back.

## Uninstalling

Stop and disable the service first, so nothing writes to the store while it is being removed:

```bash
sudo systemctl disable --now ipfs-node
```

Under PM2, use `pm2 delete "IPFS node"` and remove the saved process list.

Then remove the store directory. With the shipped `storeFolder` that is `~/.adm-ipfs` in the home
directory of the service user:

```bash
rm -rf /var/lib/ipfs-node/.adm-ipfs
```

Removing the store is irreversible and destroys more than cached content:

- the libp2p private key kept in the datastore under `/pkcs8/self`, which is the node's peer
  identity. Every peer that lists this node by `/p2p/<peer-id>` has to be reconfigured after a
  rebuild.
- every block in the blockstore, together with the pin set. Any file whose only remaining copy was
  held here is gone.
- the file lifecycle registry, the repair cursor, and the health checkpoint

Back the directory up first if any of that content still matters; see
[Persistent state and backups](/operations/persistence). Finally delete the checkout, which also
removes `config.json5` and the administrative key it contains, and remove the service account if it
is no longer used.
