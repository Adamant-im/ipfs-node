---
title: ADAMANT Messenger
description: How the reference deployment uses the node, what the node does and does not know about it, and what another application should change.
---

# ADAMANT Messenger

[ADAMANT Messenger](https://adamant.im) runs this node in production for attachment delivery. It is
the deployment the defaults in `config.default.json5` were shaped against, and the reason a few
compatibility decisions in the HTTP contract exist.

## Why it is here

An adopter is useful evidence: it shows the service running against real traffic and it explains
otherwise puzzling parts of the contract. It is not the product's purpose. The node is a
general-purpose storage service, and every page of this documentation is written so that a
non-ADAMANT application can follow it unchanged.

If you are evaluating the node for your own application, [Use cases](/guide/use-cases) and
[Comparison](/guide/comparison) are the pages to read; this one is context.

## How the messenger uses the node

The access shape is write-once, read-by-CID:

- a client uploads an attachment through `POST /api/file/upload` and receives its CID
- the CID travels to the recipient inside the message
- the recipient's client fetches it through `GET /api/file/:cid`

Sender and recipient are usually on different nodes. That is why a node fetches content it does not
hold and streams it on rather than redirecting: the recipient learns the CID as soon as the message
arrives and asks its own node for it immediately, long before any background job could have moved a
copy there. Routing stays the node's problem, not the client's — see
[Architecture](/guide/architecture).

Nothing is ever mutated in place, so the absence of mutable naming costs this deployment nothing.

## What the node does and does not know

The node stores whatever bytes it is given and does not encrypt content. Content encryption is the
responsibility of the ADAMANT client protocol; the node never sees a plaintext attachment and never
sees an account.

It also has no notion of the message that carried the CID, of who uploaded it, or of who read it.
Access time is deliberately not recorded: replication tiers on file age rather than on recency,
because recording when a file was last read would build a trail of user activity, and sharing that
trail between nodes would spread it further. See [Security and privacy](/guide/security).

## Compatibility surface

Three parts of the contract exist because of existing clients, and they are documented as
compatibility decisions rather than as recommendations:

- `POST /api/file/upload` is unauthenticated, so clients can upload directly. It is bounded by size,
  count, rate, concurrency, and the disk reserve, but it is not an authorization guarantee.
  Uploader-signed authorization is open work in [issue #27](https://github.com/Adamant-im/ipfs-node/issues/27)
- `GET /api/node/info` is a public, sanitized route retained for the current PWA and iOS
  application. It carries no peer identity and no topology; the detailed operator response moved to
  the authenticated `GET /api/node/details`
- `GET /api/file/:cid` ignores `Range` and answers with the complete representation and
  `Accept-Ranges: none`, preserving existing client behaviour

A new application is free to place its own gateway in front of the node and enforce whatever
authorization it needs.

## Running your own deployment instead

`config.default.json5` is the ADAMANT production template. Its `nodes` and
`peerDiscovery.bootstrap` lists point at the ADAMANT production mesh, and its `cors.allowedOrigins`
entries are ADAMANT origins. **A deployment that is not joining ADAMANT must replace all three.**
Leaving `nodes` and `peerDiscovery.bootstrap` empty runs a standalone node.

Start at [Quick start](/guide/quick-start), or [Docker](/guide/docker) for a container. The
messenger client itself is developed in
[Adamant-im/adamant-im](https://github.com/Adamant-im/adamant-im), and the wider protocol
documentation is at [docs.adamant.im](https://docs.adamant.im).
