---
title: Architecture
description: How the node is composed, how it reaches its peers, what runs between them, and which trust boundaries a deployment has to enforce itself.
---

# Architecture

The node is a single Node.js service built on Helia and libp2p. It keeps content in a local
blockstore, exchanges blocks with a configured set of peers, and exposes an HTTP API for
applications. It is not a wrapper around Kubo, it does not expose a Kubo-compatible API, and it does
not take part in the public IPFS network.

Everything on this page is the current behaviour of the code. Option names and defaults are
described in [Configuration](/guide/configuration); request and response details are in the
[API reference](/reference/api).

## Process layout

One process runs everything. `src/index.ts` is the entry point: it builds the Express application
and starts the scheduled work. `src/helia.ts` creates the Helia node at import time, so every router
shares one node instead of opening a second one.

Two ports are used: the HTTP API listens on `serverPort`, and libp2p listens on the multiaddrs in
`peerDiscovery.listen`. The configuration templates in the repository use `4000` and
`/ip4/0.0.0.0/tcp/4001`.

The HTTP API and the Helia node share one blockstore and one datastore, both opened in
`src/store.ts` before the node starts. An upload writes blocks through UnixFS into the same
blockstore that Bitswap serves to peers, and the pin set, the file registry and the health
checkpoint live in the same datastore. There is no sidecar daemon and no second copy of the data.

Scheduled work runs in the same process:

| Job                | Schedule                      | Purpose                                                                                                        |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Disk usage         | `diskUsageScanPeriod`         | Refreshes the storage report behind `GET /api/storage/metrics`; one scan also runs at startup                  |
| Peering            | `peeringSchedule`             | Redials the entries in `nodes` that are not connected                                                          |
| Garbage collection | `storage.gc.schedule`         | Frees blocks when space is short; started only when `storage.gc.enabled` is true                               |
| Admission recovery | `storage.gc.schedule`         | Replaces the collector when it is disabled, clearing upload tokens whose handler died                          |
| Replication repair | `replication.repairSchedule`  | Restores missing copies; started only when `replication.enabled` and `replication.repairEnabled` are both true |
| Health checkpoint  | `health.checkpointIntervalMs` | Writes the readiness checkpoint on a fixed interval timer rather than on a cron expression                     |

## libp2p composition

The node is composed explicitly from `createHeliaLight`, `withLibp2pLight` and `withBitswap` instead
of `createHelia`. `createHelia` merges the Helia default libp2p configuration — mDNS, the public IPFS
bootstrap list, kad-DHT, AutoNAT, AutoTLS, UPnP, circuit relay and the WebRTC and WebSocket
transports — into whatever is passed to it, which would widen the peer topology without the operator
asking for it. The light constructors apply exactly the configuration given here, which also keeps
the kad-DHT service out of the process.

Bitswap is kept, because it is how known peers exchange blocks. HTTP gateway routing is not
registered, so a block request never leaves the configured peer set.

The resulting libp2p configuration is exactly this:

| Element               | Value                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Transport             | `tcp()`                                                                                   |
| Connection encryption | `noise()`                                                                                 |
| Stream multiplexer    | `yamux()`                                                                                 |
| Peer discovery        | `bootstrap()` over `peerDiscovery.bootstrap`, registered only when that list is not empty |
| Services              | `identify()` and `ping()`                                                                 |
| Block exchange        | Bitswap                                                                                   |
| Listen addresses      | `peerDiscovery.listen`                                                                    |
| Connection ceiling    | `connectionManager.maxConnections`, default `100`                                         |
| Connection allow list | `connectionManager.allow`, set to the `multiAddr` of every entry in `nodes`               |
| Peer identity         | libp2p private key loaded from, or created in, the datastore at `/pkcs8/self`             |

`identify` lets peers exchange supported protocols and observed addresses. `ping` backs
`GET /api/libp2p/services/ping`. Nothing else is registered: there is no DHT, no mDNS, no circuit
relay, no AutoNAT, AutoTLS or UPnP, no WebRTC or WebSocket transport, no gateway routing and no
IPNS.

Because the private key lives in the datastore, the peer id is stable across restarts, which is what
lets other operators keep a fixed `multiAddr` for this node.

```text
        HTTP clients                         reverse proxy (TLS)
              |                                     |
              v                                     v
  +-------------------------------------------------------------------+
  |  one Node.js process                                              |
  |                                                                   |
  |   Express API                        Helia + libp2p               |
  |   :serverPort                        :peerDiscovery.listen        |
  |   routers, rate limits,              TCP / Noise / Yamux          |
  |   admission, size limits             identify, ping, Bitswap      |
  |            |                                    |                 |
  |            +----------------+-------------------+                 |
  |                             v                                     |
  |             blockstore-fs  +  datastore-fs                        |
  |                  $HOME/<storeFolder>                              |
  |                                                                   |
  |   scheduled jobs: disk usage, peering, garbage collection,        |
  |                   replication repair, health checkpoint           |
  +-------------------------------------------------------------------+
                     |                          |
      /adamant/replication/1.0.0     /adamant/health/1.0.0
                     |                          |
                     v                          v
          +--------------------+     +--------------------+
          |  peer from "nodes" |     |  peer from "nodes" |
          +--------------------+     +--------------------+
```

## Peer topology

The peer set is the `nodes` list in the configuration file. Every entry carries a name and a
`multiAddr` containing `/p2p/<peer-id>`, so a peer is identified by its key rather than by its
address.

`@libp2p/bootstrap` dials the addresses in `peerDiscovery.bootstrap` once shortly after start and
never again. Nothing in libp2p reconnects a peer that restarted or dropped, and a mesh that quietly
comes apart still accepts uploads, so the failure surfaces later as slow retrieval and as
replication that cannot place copies. The peering job closes that gap: on every `peeringSchedule`
tick it dials the entries in `nodes` that are not currently connected, gives each dial ten seconds,
and logs the failures at debug level. The work is bounded by the size of the operator's own peer
list.

The `allow` list holds the same addresses. It keeps configured peers connectable once
`maxConnections` is reached. It is not an access control list: no deny list is configured, so any
peer that can reach the listen address may still open a connection. What a connected peer is allowed
to ask for is decided by the protocol handlers, not by the connection manager.

There is no DHT, mDNS, relay or NAT traversal, because the peers are known in advance. Content
routing is unnecessary when every candidate holder is named in the configuration, and leaving those
services out keeps the kad-DHT implementation out of the process. That has two consequences an
operator has to plan for:

- Every node needs an address its peers can dial directly. Without hole punching or relaying, a node
  behind NAT needs a forwarded port and a `multiAddr` that reflects it.
- Adding or removing a node is a configuration change on every other node, and it resets the health
  checkpoint epoch. Automatic peer discovery is open work in [issue #28](https://github.com/Adamant-im/ipfs-node/issues/28).

Avoiding the public DHT and public gateways reduces how much content-routing metadata is published
to strangers. It does not by itself make a deployment private, anonymous, trustless or
censorship-proof: the HTTP API is reachable by anyone who can reach the port, peer addresses live in
each operator's configuration, and the operators of the listed nodes can read what they store.

## Protocols between nodes

Two libp2p protocols run between nodes:

- `/adamant/replication/1.0.0` places, probes and withdraws copies
- `/adamant/health/1.0.0` collects checkpoint attestations

Both run over libp2p streams rather than over the REST API. The libp2p handshake already proves the
remote peer id cryptographically, so no shared secret has to be distributed, no second HTTP port has
to be exposed, and no peer has to publish an HTTP address for the others to reach it. Messages on
both protocols are length-prefixed JSON with a hard size cap, and a request that exceeds it, or that
does not complete before its timeout, aborts the stream.

The replication protocol carries seven operations:

| Operation | Meaning                                                            | Accepted from           |
| --------- | ------------------------------------------------------------------ | ----------------------- |
| `store`   | Store and pin the CID, pulling the blocks over the connection      | Peers listed in `nodes` |
| `stage`   | Prepare a pin that becomes permanent only after the upload commits | Peers listed in `nodes` |
| `commit`  | Make a prepared copy permanent                                     | Peers listed in `nodes` |
| `abort`   | Withdraw one upload's claim on a prepared copy                     | Peers listed in `nodes` |
| `have`    | Report whether this node deliberately holds the CID                | Peers listed in `nodes` |
| `accept`  | Report whether this node has room for another copy                 | Peers listed in `nodes` |
| `cache`   | Hold an unpinned copy nobody is responsible for                    | Any connected peer      |

The authorization rule is the same on both protocols: anything that makes this node responsible for
content, and every health attestation, is accepted only from a peer whose id appears in `nodes`.
Everything else is refused with `not_authorized`, and the refusal is logged. Until file ownership is
signed by the uploader, that check is what stands between the node and an arbitrary peer spending
its disk. Uploader-signed authorization is open work in [issue #27](https://github.com/Adamant-im/ipfs-node/issues/27).

`cache` is deliberately open, because it grants nothing a reader does not already have. The blocks
are neither pinned nor registered, so they sit in the same tier as content cached while answering a
read and are reclaimed as soon as space is short, and the DAG is fetched through Bitswap from
whichever connected peer has the blocks — the same path a public read uses. Open is not unbounded:
the request is refused with `no_room` when the node has none, one copy is held to the same size an
upload is, and per-peer and node-wide intake budgets over a rolling window bound how much bandwidth
and cache space peers can spend together.

The protocol version describes the wire format, not the release. Taking it from `package.json` would
break interoperability on every release, so it is raised only when the format changes in a way an
older node cannot read. The node offers the versions it speaks, newest first, and libp2p negotiates
the first one both ends support. There is currently one entry, so a mixed-version deployment cannot
place copies and an upgrade has to be applied to every node. `GET /api/storage/metrics` reports the
protocol string this node offers under `replication.protocol`, which is what makes a half-upgraded
network visible.

The health protocol adds three checks of its own on top of authorization. An attestation is refused
when the caller's `membershipVersion` differs from the local one, when the requested round is
neither the local round nor an adjacent one, or when the two timestamps differ by more than
`health.clockSkewToleranceMs`. The membership version is a hash of the sorted peer ids in `nodes`,
so two nodes configured differently cannot attest each other. See
[Monitoring](/operations/monitoring) for how those checkpoints are read.

## Content flow

An upload arrives at `POST /api/file/upload`. The rate limiter runs first, then admission refuses
the request before any block is written when the node is at its concurrency limit, when the
aggregate request size is too large, or when storing the request would eat into the disk reserve.
The multipart parser enforces `maxFileCount` and the per-file `uploadLimitSizeBytes` while the bytes
flow, and rejects non-file fields, so an over-limit part never reaches the blockstore. Content is
imported into UnixFS as it streams. Once the parts are in, the handler takes an exclusive lock on
every CID in the request, writes a pin-intent marker, pins, and registers the file; then it places
copies on peers and commits the local records and the remote copies together.

A download arrives at `GET /api/file/:cid`. After the read limiter and the global and per-client
concurrency guards, the node routes the request itself before asking for any block:

1. If the block is already in the local blockstore, nothing else happens.
2. Otherwise the node computes the file's likely holders by ranking the configured peers against the
   CID, widened by a couple of places so that a file stored just outside the current holder set is
   still covered, and dials those that are not connected. The dials are best effort and bounded by a
   short timeout; a peer that cannot be reached quickly must not delay the read.
3. Bitswap then fetches the blocks from whichever of the connected peers has them.

There is no DHT lookup and no gateway fallback at any step, so a CID whose holders are outside the
configured peer set cannot be found. When discovery does not complete within `findFileTimeout`, the
request is answered `408 File request timed out`. The node never answers `404` for a CID it cannot
retrieve, because it cannot know whether the content exists somewhere it cannot see; `404` on this
API means an unknown registry record or an unrouted path. Once streaming starts, an idle timeout and
a size-aware total deadline bound the response.

Blocks pulled in while serving a read stay in the blockstore unpinned and unregistered. They cost
nothing to keep while there is room and are reclaimed by the collector when space is short, which is
the same tier that holds copies taken through the `cache` operation. Pinning, confirmation,
replication tiers and reclamation are described in full in
[the storage lifecycle](/storage-lifecycle).

## Persistent state

Everything durable lives under one directory, `$HOME/<storeFolder>`, where `storeFolder` defaults to
`.adm-ipfs`. Both subdirectories are created at startup if they are missing.

| Path          | Contents                                  |
| ------------- | ----------------------------------------- |
| `blockstore/` | Content blocks, stored by `blockstore-fs` |
| `datastore/`  | Everything else, stored by `datastore-fs` |

The datastore holds:

- the libp2p private key at `/pkcs8/self`, which is the node's peer identity
- the Helia pin set, which decides what is durable
- the file lifecycle registry under `/adm/files`
- pin-intent markers under `/adm/pin-intent`
- the health checkpoint at `/adm/health/checkpoint`
- the replication repair cursor and evidence at `/adm/health/repair-cycle`

Losing the datastore is not the same as losing the blockstore. Without it the node comes up with a
new peer id, and every other operator's `nodes` entry for it stops matching. Back up and restore the
whole directory as one unit; see [Persistence](/operations/persistence).

The path is resolved from the home directory of the process user, so it depends on which user runs
the service, and a service manager that changes `HOME` changes where the data goes. An optional
absolute `dataDir` option is open work in [issue #30](https://github.com/Adamant-im/ipfs-node/issues/30) and is not implemented.

## Trust boundaries

| Boundary                    | What it gives                                                                                                                                                        | What it does not give                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP public routes          | Rate limits, upload and download concurrency admission, size limits and the disk reserve are enforced before work starts                                             | No caller identity. Anyone who can reach the port can upload and read, and content is not authorized by its uploader ([#27](https://github.com/Adamant-im/ipfs-node/issues/27)). A deployment that needs upload authorization must enforce it in front of the node |
| HTTP administrative routes  | `x-api-key` is compared in constant time against `adminApiKey`; a missing or wrong key is `401`, and an unset key makes the routes answer `503`, so they fail closed | No per-operator identity: one shared secret, and two holders of it are indistinguishable in the logs. No TLS at the application level                                                                                                                              |
| libp2p peers in `nodes`     | The handshake proves the peer id, so durable operations and health attestations come from a key the operator listed, with no shared secret to distribute             | Identity is not honesty. A listed peer can claim it holds a file, refuse to take one, or stop answering, and its operator can read everything stored on it                                                                                                         |
| libp2p peers not in `nodes` | They may connect, exchange blocks over Bitswap, and ask for an unpinned `cache` copy bounded by the intake budgets and the disk reserve                              | They cannot make this node responsible for content, cannot commit or abort a copy, and cannot contribute to health readiness                                                                                                                                       |
| Reverse proxy               | TLS termination, and a trustworthy client address for rate limiting when `trustProxy` names exact addresses, CIDRs or a verified hop count                           | Nothing by default: with `trustProxy: false` every client shares the proxy address for rate limiting, and `true` is rejected outright. The proxy is also where deployment-specific authorization has to live                                                       |

The HTTP surface and its access classes are described in [Security](/guide/security).

## Public IPFS limitations

This node is not a participant in the public IPFS network, and choosing it for public
interoperability would be a mistake. There is no DHT, no public bootstrap list, no gateway routing
and no IPNS, in either direction:

- A CID uploaded here is announced nowhere. Public gateways, Kubo nodes and other IPFS clients will
  not find it unless they connect directly to one of the configured nodes.
- A CID that exists only on the public network cannot be fetched here. The node asks the peers it
  was configured with and nothing else, and the request ends in `408`.

Content addressing itself is unchanged: the CIDs are ordinary IPFS CIDs and the blocks are ordinary
UnixFS blocks, so nothing about the data format prevents interoperability later. Making that work is
research, tracked in [issue #31](https://github.com/Adamant-im/ipfs-node/issues/31), and it is not available today. [Comparison](/guide/comparison)
covers when Kubo, IPFS Cluster or a public gateway is the better choice.

## Startup and shutdown

Module evaluation happens before the entry point body runs: the configuration file is selected and
validated, an invalid field aborts the process, the blockstore and datastore are opened, and the
Helia node is created and started, logging one `Listening on <multiaddr>` line per listen address
and then `Helia is running! PeerID: <peer id>`.

The entry point then proceeds in this order:

1. Log `Using config file: <name>`.
2. Start the disk-usage job.
3. Start the peering job and run one peering pass to completion, so the node joins the mesh before
   it serves any request.
4. Snapshot the pin set. This decides which pins are legacy before the node can accept new ones, so
   a replica staged later is never mistaken for pre-existing content.
5. Register the replication protocol handler with `replication.requestTimeoutMs`. It is registered
   whether or not this node places copies of its own, so a node can be added to a network without
   reconfiguring every other node first.
6. Initialize replication repair state, then start the health service. It loads the persisted
   checkpoint, discards one written under a different membership version, registers the health
   protocol, runs one checkpoint immediately, and then repeats on `health.checkpointIntervalMs`.
7. Start registry backfill and admission recovery in the background. They are deliberately not
   awaited: reads, uploads and incoming copies do not need a complete registry, and blocking here
   would make the whole API unavailable for the length of the migration. When they settle, the
   startup reconciliation result is recorded and the lifecycle jobs start — the collector, or
   admission recovery when the collector is off, and replication repair when it is enabled.
8. Build the Express application: disable `x-powered-by`, apply `trust proxy`, mount request logging
   and metrics collection, apply the CORS policy, answer `GET /` with `IPFS node`, mount the API
   routers at their access classes, then the not-found and error handlers. A warning is logged when
   `trustProxy` is `false`.
9. Listen on `serverPort`, logging `Server is running on http://localhost:<port>` and a warning that
   TLS is not handled at the application level.
10. Register the `SIGINT` and `SIGTERM` handlers, each of which runs once.

Shutdown runs on either signal:

1. Log `Received SIGTERM, shutting down`, or the same line for `SIGINT`.
2. Stop the disk-usage, peering, garbage-collection and admission-recovery jobs.
3. Begin stopping replication repair and the health service; both are settled together in the
   background.
4. Arm two timers: idle HTTP connections are force-closed after 12 s, and a hard deadline fires at
   15 s.
5. Close the HTTP server. In-flight requests finish; idle keep-alive connections are closed when the
   12 s timer fires.
6. Once the server is closed, wait for the background jobs to stop, then stop Helia, which logs
   `Helia node stopped`, and exit with code `0`.
7. If the hard deadline fires first, log `Shutdown timed out` and exit with code `1`.

A supervisor or container stop timeout therefore has to outlast the 15 s deadline; give it at least
20 s. See [Docker](/guide/docker) for the packaged defaults.
