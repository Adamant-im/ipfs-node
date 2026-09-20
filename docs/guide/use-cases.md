---
title: Use cases
description: Where ADAMANT IPFS Node fits, where another storage system is the better answer, and how to decide between them.
---

# Use cases

ADAMANT IPFS Node is a self-hosted IPFS storage node for application file delivery, with bounded
disk usage, deterministic replication, repair, health checkpoints, and a REST API. It is a
standalone Node.js service composed from Helia and libp2p, not a wrapper around Kubo and not a
Kubo-compatible API.

The fit follows from the topology. The libp2p node uses TCP only, registers `identify` and `ping`,
and discovers peers exclusively from the multiaddrs listed in `nodes`. There is no DHT, no mDNS,
no relay, no NAT traversal, no IPNS, and no HTTP gateway routing. Retrieval dials the peers that
the placement policy says should hold the CID, so a read never depends on public content routing.

## Good fit

### Application-owned content-addressed file delivery

An application uploads through `POST /api/file/upload`, receives a CID, and any node in the set
serves that CID through `GET /api/file/:cid`. The identifier is content-derived, so it is stable
and verifiable, and every accepted file gets a lifecycle record the node can report on through
`GET /api/file/:cid/status`. Placement is deterministic rather than negotiated: each node ranks
candidate holders for a CID with rendezvous hashing over the configured peer set, so every node
derives the same holders without coordination. That works when the storage nodes are known in
advance and administered by one team or by parties that already trust each other.

### Privacy-conscious deployments preferring a controlled peer mesh

Because no content router is registered, the node does not advertise CIDs to the public DHT and
does not serve content through a public gateway. Blocks move over Bitswap between connected peers
from the configured set. That reduces public exposure of content-routing metadata compared with a
node that announces every block it stores.

It does not make a deployment private, anonymous, trustless, or censorship-proof. The libp2p
listener accepts connections from any dialer that can reach it, only durable replication and
health attestations are restricted to peers listed in `nodes`, uploads and reads are unauthenticated
by design, and TLS is terminated outside the process. See [Security](/guide/security) for the
boundaries an operator still has to draw.

### Replication, repair, bounded storage, and health without a second control plane

One process runs the HTTP API, the Helia node, the replication protocol, the repair cycle, the
garbage collector, and the health service, configured by one JSON5 file. Durability is expressed
as `replication.placement` tiers that reduce copies as a file ages, missing copies are re-placed
by the scheduled repair cycle in bounded passes, and disk usage is bounded by
`storage.gc` watermarks, `storage.diskReserveBytes`, and the upload admission limits.
`GET /api/node/health` reports a state and a persisted checkpoint height, and
`GET /api/storage/metrics` reports storage counters and job state. Teams that would otherwise
operate a separate pinning-orchestration control plane next to their IPFS daemon get this from a
single service. See [the storage lifecycle](/storage-lifecycle) and
[Monitoring](/operations/monitoring).

### Messenger and media-attachment storage

Attachments are written once and read by whoever holds the CID, which is exactly the access shape
the node implements. Uploads are accepted without authentication so that clients can post directly,
downloads are streamed as `application/octet-stream` attachments with sniffing disabled and an
`ETag` for revalidation, and per-client plus node-wide download concurrency limits keep one address
from occupying every transfer slot. Nothing is ever mutated in place, so the absence of mutable
naming costs such a deployment nothing.

Unauthenticated upload is a compatibility decision, not an authorization guarantee. A deployment
that needs signed upload authorization must enforce it at a trusted gateway in front of the node.

### Self-hosted services that prefer predictable limits to breadth

Every limit is an explicit configuration field, and validation aborts startup naming the field that
is wrong or contradictory, so a misconfiguration surfaces before traffic does. Durable state lives
in one directory, and the container image keeps it on one volume. The trade is deliberate: this is
a focused storage service, not a full public IPFS implementation, and features outside that scope
are absent rather than partially implemented. See [Configuration](/guide/configuration) and
[Docker](/guide/docker).

## Choose another solution when

### You need a general-purpose public IPFS node

Use [Kubo](https://github.com/ipfs/kubo). This node does not participate in the public DHT, does
not implement IPNS or any mutable naming, does not expose a gateway, and does not implement the
Kubo HTTP RPC surface. Existing Kubo clients and tooling will not work against it; the REST API is
its own contract, documented in [API reference](/reference/api).

### The cluster is large, dynamic, or made of mutually untrusted operators

Use [Kubo with IPFS Cluster](https://ipfscluster.io). Peers come from a static `nodes` list that
must be applied consistently on every member, bootstrap dials that list once and `peeringSchedule`
keeps it connected, and changing the list changes the peer-set epoch, which resets persisted health
checkpoint heights. Durable placement is accepted only from configured peers, so every member is a
party the others have chosen to trust. Peer discovery instead of static lists is open work
([issue #28](https://github.com/Adamant-im/ipfs-node/issues/28)) and is not available.

### End users must own their files and delete them

Deletion is administrative. `POST /api/file/:cid/unpin` requires the admin key and releases the
file on the node that received the call; the blocks are reclaimed by the next collection, and other
holders are unaffected by that call. There is no protocol by which the uploader proves ownership
and requests removal: uploader-signed deletion is open work ([issue #27](https://github.com/Adamant-im/ipfs-node/issues/27)). Until it exists, an
application that must offer authenticated end-user deletion needs its own authorization layer in
front of the node, or a storage system that models per-object ownership.

### You need built-in egress accounting and monthly quotas

Use object storage with metering, or meter at a gateway in front of the node. The node enforces
per-endpoint rate limits and concurrency caps, but it does not account for transferred bytes per
client and has no monthly transfer limit. Traffic accounting and monthly limits are open work
([issue #29](https://github.com/Adamant-im/ipfs-node/issues/29)).

### Content must be reachable from the public IPFS network

Use [Kubo](https://github.com/ipfs/kubo) or a managed pinning provider. Nothing stored here is
announced to public content routing, and no public gateway serves it, so an outside client cannot
find the content unless it dials one of the deployment's nodes directly. Public-network
interoperability is under research ([issue #31](https://github.com/Adamant-im/ipfs-node/issues/31)) and must not be assumed.

### You need the S3 ecosystem, mature cloud IAM, lifecycle tiers, or managed global delivery

Use object storage. The node has one administrative API key rather than per-user identities,
roles, or policies; its lifecycle is a pin registry plus a garbage collector rather than storage
classes and transition rules; and it has no managed multi-region distribution. Applications built
around S3-compatible SDKs, bucket policies, or signed object URLs will be fighting the design.

## Deciding

| If you need                                                                                                      | Use                        |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Content-addressed file delivery over a REST API, with bounded disk usage and replication across a known peer set | ADAMANT IPFS Node          |
| Public DHT participation, IPNS, a gateway, or the Kubo RPC surface                                               | Kubo                       |
| Pinning orchestration across a large, changing, or independently operated fleet                                  | Kubo with IPFS Cluster     |
| An IPFS node embedded in your own service, with your own storage, routing, and API choices                       | A custom Helia application |
| Content served by the public IPFS network without operating nodes yourself                                       | A managed pinning provider |
| S3-compatible APIs, IAM, lifecycle tiers, or managed global delivery                                             | Object storage             |

For a feature-by-feature breakdown of these options, see [Comparison](/guide/comparison).

## Reference deployment

ADAMANT Messenger stores chat attachments on a mesh of these nodes, and `config.default.json5`
ships with that mesh as its peer list. It is an adopter and a worked example rather than the
purpose of the project: the node is meant for any application with the same access shape. See
[ADAMANT Messenger](/guide/adamant-messenger).
