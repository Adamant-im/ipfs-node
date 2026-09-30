---
title: What it is
description: Overview of the ADAMANT IPFS node, a self-hosted storage service with a REST API, deterministic replication, repair, and health checkpoints.
---

# ADAMANT IPFS Node

## What it is

Self-hosted IPFS storage node for application file delivery, with bounded disk usage, deterministic
replication, repair, health checkpoints, and a REST API.

The node is a standalone Node.js service. It embeds a Helia node and a libp2p host in its own
process and puts an Express REST API in front of them. Files are uploaded over HTTP, imported into
an on-disk blockstore as UnixFS content, addressed by CID, and served back over HTTP. It is not a
wrapper around Kubo, it does not speak the Kubo RPC API, and it is not an IPFS gateway: the HTTP
surface is a small, versioned application API, not a general-purpose IPFS interface.

The libp2p host is composed explicitly from `createHeliaLight`, `withLibp2pLight`, and
`withBitswap` rather than from `createHelia`, so only the transports and services listed in the
configuration are registered. A deployment is a set of nodes that know each other by multiaddr:
each node lists its peers under `nodes`, dials them at startup and on a schedule, and exchanges
blocks, replicas, and health attestations with them.

The audience is application developers who need file storage behind their own API, service
operators who run that storage themselves, and self-hosters who want content-addressed storage
with predictable disk behaviour. ADAMANT Messenger is an adopter and a reference deployment of the
node, not the reason it exists; see [ADAMANT Messenger](/guide/adamant-messenger) for how that
deployment is configured.

## What it is not

- Not a public IPFS node. It connects to the peers it is configured with, and content is not
  announced to the wider network.
- No DHT participation. No kad-DHT service is registered, so the node neither publishes nor
  resolves provider records.
- No IPNS. There is no naming layer, no record publishing, and no name resolution.
- No public gateway. There is no `/ipfs/` path routing and no HTTP gateway block routing; the
  download route serves a CID as an attachment through the application API.
- No Kubo API compatibility. The RPC API of Kubo is not implemented and its client libraries do
  not work against this service.
- No end-user identity or session layer. The only authentication is a single administrative
  `x-api-key` for operator endpoints; public routes have no accounts, tokens, or sessions.
- No S3 API. There are no buckets, no object keys, and no S3-compatible request signing.
- No built-in TLS. The process serves plain HTTP and logs a warning at startup that TLS must be
  terminated by a reverse proxy in front of it.

## Feature overview

| Capability                       | Description                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST upload and download         | `POST /api/file/upload` accepts multipart `files` parts; `GET /api/file/:cid` streams the content back                                              |
| Content addressing               | Uploads are imported as UnixFS byte streams and identified by the resulting CID                                                                     |
| Controlled peer mesh             | TCP transport, Noise encryption, and Yamux multiplexing, with only the `identify` and `ping` libp2p services registered                             |
| Bitswap block exchange           | Blocks move over Bitswap between connected peers; no DHT or HTTP gateway routing is registered, so requests are not published to the public network |
| Bounded storage lifecycle        | Disk reserve, aggregate request limits, temporary uploads with a TTL, and watermark-driven garbage collection                                       |
| Deterministic placement          | Rendezvous hashing over the configured peer set, so every node computes the same holders for a CID without negotiating                              |
| Quorum or best-effort durability | `replication.ackQuorum` counts acknowledged copies; `requireQuorumOnUpload` decides whether a short upload fails or succeeds best effort            |
| Replication repair               | A scheduled, resumable cycle re-places copies for records that fall short of their placement                                                        |
| Health checkpoints               | A monotonic checkpoint advances only when local prerequisites and the required peer attestations pass                                               |
| Rate and concurrency limits      | Per-endpoint rate limiters for upload, pin, and read, plus admission control on concurrent uploads and downloads                                    |
| Structured logging               | Pino writes newline-delimited JSON, with CIDs, peer identities, and credentials scrubbed from records                                               |

Defaults for every option named above are listed in [Configuration](/guide/configuration), and the
full request and response contract in [API overview](/reference/api).

## Trust and topology boundaries

A controlled peer list changes what the network can observe about a deployment, and it is worth
being precise about how much. Avoiding the public DHT and public gateways means the node does not
publish provider records and does not answer gateway traffic, which keeps content-routing metadata
off the public network. It does not make a deployment private, anonymous, trustless, or
censorship-proof: the operator of every node in the list sees the content it holds, the transport
is still ordinary TCP over the public internet, and a network observer still sees connections
between the nodes.

Within that list, membership is what authorizes work. The libp2p handshake proves the remote peer
identity cryptographically, so no shared secret is distributed and no additional port is exposed.
Durable replication operations on `/adamant/replication/1.0.0` are refused with `not_authorized`
unless the calling peer id appears in `nodes`, and health attestations on
`/adamant/health/1.0.0` are counted only for the peers configured there. Holding an unpinned cache
copy is the one operation open to any peer, because it costs no more than serving a read to the
same peer and the blocks are reclaimed as soon as space is short.

A controlled list is not a private-network keying model. There is no pre-shared network key and no
connection gater: the configured multiaddrs are the connection-manager `allow` list, which exempts
them from the connection ceiling rather than excluding anyone else, so any peer that can reach the
libp2p listener can still complete a handshake. Restricting who may reach that port is a network
boundary, not an application setting; see [Security and privacy](/guide/security).

## Current limitations

The following are tracked as open work and are **not available today**:

- Uploader-signed deletion ([#27](https://github.com/Adamant-im/ipfs-node/issues/27)). Upload is unauthenticated, and there is no protocol by which an
  uploader proves ownership in order to delete content. A deployment that needs authorized upload
  or deletion must enforce it at a trusted gateway in front of the node.
- Peer discovery beyond static lists ([#28](https://github.com/Adamant-im/ipfs-node/issues/28)). Every node must be listed in `nodes` on every other
  node, and changing that list resets the health checkpoint epoch.
- Traffic accounting and monthly limits ([#29](https://github.com/Adamant-im/ipfs-node/issues/29)). The node applies rate and concurrency limits, but
  does not meter transferred bytes per client or enforce a volume budget.
- Absolute `dataDir` ([#30](https://github.com/Adamant-im/ipfs-node/issues/30)). The store is always resolved under the home directory as
  `$HOME/<storeFolder>`, so relocating it means changing `HOME` or the folder name.
- Public IPFS interoperability ([#31](https://github.com/Adamant-im/ipfs-node/issues/31)). Content stored here is not retrievable from the public IPFS
  network, and public content is not retrievable through this node.

Progress on each is tracked in the
[issue tracker](https://github.com/Adamant-im/ipfs-node/issues).

## Where to go next

- [Use cases](/guide/use-cases) for the deployments this node fits and the ones it does not
- [Comparison](/guide/comparison) for how it differs from Kubo and IPFS Cluster
- [Architecture](/guide/architecture) for the storage, replication, and health internals
- [Quick start](/guide/quick-start) to run a node and upload a first file
