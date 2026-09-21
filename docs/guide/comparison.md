---
title: Comparison
description: How ADAMANT IPFS Node compares in design scope with Kubo, IPFS Cluster, a custom Helia application, managed pinning, and object storage.
---

# Comparison

## How to read this page

This page compares design scope, not speed. It describes what each option is built to do, what it
asks an operator to run, and where its boundaries lie. It is not a benchmark: no performance,
capacity, or availability measurements are published for this project, so none appear here, and no
version-specific behaviour is attributed to any other project. Statements about the alternatives are
deliberately general; read their own documentation before choosing one.

## At a glance

| Property                      | ADAMANT IPFS Node                                                                   | Kubo                                                      | Kubo with IPFS Cluster                         | Custom Helia application                             | Managed provider                            | Object storage                                 |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| Runtime                       | One Node.js 24 process embedding Helia and Express                                  | A Go daemon                                               | A Go daemon plus a cluster daemon per node     | A Node.js process the author maintains               | Hosted by the provider                      | Hosted service, or a self-hosted server        |
| Peer discovery                | Static `nodes` list, dialled at startup and kept up on `peeringSchedule`            | Public IPFS bootstrap peers and local network discovery   | As Kubo, plus a cluster peer set               | Whatever the author configures                       | Provider-operated                           | None; clients address a service endpoint       |
| Content routing               | None; holders are derived from the CID                                              | Participates in the public DHT                            | Public DHT through Kubo                        | Whatever the author configures                       | Provider-operated                           | None; keys are location-addressed              |
| Public gateway                | None                                                                                | Ships an HTTP gateway                                     | Kubo's HTTP gateway                            | Only if the author builds one                        | Provider-operated                           | The service HTTP endpoint                      |
| Pin orchestration             | libp2p protocol `/adamant/replication/1.0.0` between configured nodes               | None; pinning is per node                                 | Consensus inside the cluster                   | None; Helia has no native pin-orchestration protocol | Provider-operated                           | Not applicable                                 |
| Placement decision            | Rendezvous hashing over the CID, with age-tiered copy counts                        | Whatever each node pins locally                           | Allocation decided by the cluster              | The author's to design                               | The provider's                              | The storage system's                           |
| Bounded local storage         | Disk reserve, GC watermarks, and a TTL for temporary files                          | Repo GC against a configured storage maximum              | Kubo repo GC, plus per-pin replication factors | The author's to implement                            | Not applicable; the provider holds the data | Quota and lifecycle policy                     |
| Built-in REST file API        | `POST /api/file/upload`, `GET /api/file/:cid`, `GET /api/file/:cid/status`          | An RPC API and gateway paths, not an application file API | A cluster API for pins; delivery through Kubo  | The author's to build                                | Provider API                                | An HTTP object API                             |
| Health/readiness contract     | `GET /api/node/health` always returns `200` with a `state` and a monotonic `height` | Not assessed here                                         | Not assessed here                              | The author's to define                               | Provider-defined                            | Service-defined                                |
| Operational components to run | One process, behind a TLS-terminating reverse proxy                                 | One daemon per node                                       | Two daemons per node, plus cluster state       | One process the author maintains                     | None                                        | None when hosted; one service when self-hosted |
| Best-fit network shape        | A small, fixed, mutually configured node set                                        | Participation in the public IPFS network                  | Large or dynamic clusters                      | Requirements this project does not cover             | No node operation wanted                    | Content addressing not required                |

"Not assessed here" means the fact was not verified while writing this page, not that the capability
is missing. Cells describing this project are taken from the code; see [Architecture](/guide/architecture)
and [the storage lifecycle](/storage-lifecycle).

## Kubo

[Kubo](https://github.com/ipfs/kubo) is the reference IPFS implementation. This project is not a
Kubo wrapper and does not expose a Kubo-compatible API.

Choose Kubo when:

- content must be reachable from the public IPFS network, through the DHT and public gateways
- the deployment wants the reference implementation and the tooling built around it
- single-node pinning is enough, and cross-node durability is handled somewhere else

Choose ADAMANT IPFS Node when:

- the node set is known in advance and content should stay inside it
- an application needs an upload and download REST API rather than an RPC surface plus a gateway
- disk usage must stay bounded by configuration, and copies must be placed and repaired without an
  additional service

Public participation is exactly what this project gives up. The controlled topology avoids the public
DHT and public gateways and reduces public exposure of content-routing metadata, but it does not by
itself make a deployment private, anonymous, trustless, or censorship-proof: the node stores and
serves whatever bytes it is given without encrypting them, the upload route is public, and anyone
who learns a CID can fetch it from any node in the set. The cost of the trade is reach. Content
stored here is not announced to the public network, and a CID that only public peers hold cannot be
retrieved through this node.

## Kubo with IPFS Cluster

[IPFS Cluster](https://ipfscluster.io) adds pin orchestration on top of Kubo by running a second
daemon beside each node and allocating pins through consensus.

Choose it when:

- the node set is large or changes often, and consensus-based allocation is worth its operational cost
- pins must be managed from outside the application that serves files
- the deployment already runs Kubo and intends to keep it

Choose ADAMANT IPFS Node when:

- the node set is small, fixed, and mutually configured
- two daemons, extra persistent state, and new failure modes per node are not wanted
- every node should compute placement itself, without a consensus round

Consensus buys an explicit, inspectable, mutable allocation: an operator can pin, unpin, and
re-allocate through the cluster, and the cluster records that decision. Rendezvous hashing buys none
of that. The designated holder set is a function of the CID and the configured peer list, so it is
not steerable per file and it changes only when the peer list changes. That is the deliberate choice
recorded in "Why not Kubo with IPFS Cluster" in [the storage lifecycle](/storage-lifecycle):
Helia-native orchestration costs one protocol handler and no new runtime, credential, or port, and
Kubo with IPFS Cluster remains the fallback if the node set ever grows past the point where
consensus-based allocation pays for itself.

## A custom Helia application

Building directly on [Helia](https://helia.io) and [libp2p](https://libp2p.io) leaves every design
decision open, which is the route this project took.

Choose it when:

- the requirements differ from this project's in ways configuration cannot cover
- the application needs libp2p services this node does not register, such as content routing or
  browser transports
- the file API must be embedded in an existing service rather than run beside it

Choose ADAMANT IPFS Node when:

- placement, repair, garbage collection, and health checkpoints would otherwise have to be written
  from scratch
- an operational contract is wanted now: startup configuration validation, bounded disk usage, a
  readiness state, and a container image

This project is a Helia application with its opinions already applied, and those opinions are
narrow. The node is composed from `createHeliaLight`, `withLibp2pLight`, and `withBitswap` rather
than `createHelia`, precisely so that no default is merged in behind the operator: transport is TCP
only, with Noise encryption and Yamux multiplexing, and the only libp2p services registered are
`identify` and `ping`. An application that needs a DHT, a relay, NAT traversal, or browser
transports is better served by building on Helia directly than by working around this node. The
source is GPL-3.0, which is worth checking against the terms a derived service needs.

## Managed IPFS pinning and storage providers

Managed providers accept content over an API and keep it available without the operator running a
node.

Choose them when:

- running, upgrading, and monitoring a node is not wanted
- content should be reachable from the public IPFS network without operating that participation
- capacity should grow without provisioning disks

Choose ADAMANT IPFS Node when:

- the data must stay on hardware the operator controls
- the deployment must keep working without an external account, API key, or third-party availability
- the content set is application-scoped and the peer list is known in advance

A provider removes the operational work this project asks for and takes the durability question off
the operator's desk. In exchange the operator gives up control over where the bytes live and over
who can observe the access pattern, and takes on a dependency whose availability and terms sit
outside the deployment. Self-hosting reverses both sides of that trade, including the parts that are
inconvenient.

## Conventional object storage

S3-compatible object storage, self-hosted or managed, is the mainstream answer for application file
delivery, and for many applications it is the right one.

Choose it when:

- content addressing, cross-application deduplication, and peer-to-peer retrieval are not requirements
- mutable keys, per-object authorization, or signed URLs are needed
- the delivery path should be a CDN in front of a bucket

Choose ADAMANT IPFS Node when:

- clients already exchange CIDs, and identical bytes must resolve to the same identifier everywhere
- any node in the set must be able to serve any file, without the client knowing which node holds it
- the storage layer should be self-hosted and free of a provider account

Object storage offers several things this node does not. Byte ranges are one: this node ignores the
`Range` header and answers `Accept-Ranges: none`, sending the complete representation with an
`ETag`. Per-object authorization is another: the download route is public, and access control has to
be applied in front of the node. Object semantics differ too, because a node that cannot retrieve a
CID answers `408` after `findFileTimeout` rather than `404` — it cannot know that the content does
not exist. What object storage does not offer is an identifier derived from the content itself, which
every node in the set resolves the same way and any client can verify.

## What this project deliberately does not do

These boundaries are design decisions, not gaps waiting to be closed by configuration.

- No DHT. No kad-DHT service is registered, so no content-routing query leaves the node and none arrives.
- No IPNS. There is no mutable naming layer; content is addressed by CID only.
- No public gateway. HTTP gateway routing is not registered, so block requests never leave the
  configured peer set, and files are served only through the node's own REST routes.
- No Kubo API. This is a Node.js service around an in-process Helia node, not a Kubo wrapper and not
  a Kubo-compatible RPC surface.
- No mDNS, circuit relay, NAT traversal, AutoNAT, AutoTLS, or UPnP, and no WebRTC or WebSocket
  transports
- No interactive API explorer. The site publishes the OpenAPI file and a generated endpoint table
  instead.
- No public IPFS interoperability. Content stored here is not announced to the public network, and
  content that only public peers hold is not retrievable through this node.

Taken together, these choices keep content routing inside a configured peer set and reduce public
exposure of content-routing metadata. They do not make a deployment private, anonymous, trustless,
or censorship-proof. The node does not encrypt what it stores, the upload and download routes are
public, and every operator in the peer set can read every file placed on their node. Deployments
that need confidentiality or upload authorization must provide them above this layer. The full
topology and the reasoning behind it are in [Architecture](/guide/architecture); the exposure model
is in [Security and privacy](/guide/security). Open questions are tracked in the
[issue tracker](https://github.com/Adamant-im/ipfs-node/issues).
