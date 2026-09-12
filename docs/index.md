---
layout: home

hero:
  name: ADAMANT IPFS Node
  text: Self-hosted content-addressed file storage
  tagline: A self-hosted IPFS storage node for application file delivery, with bounded disk usage, deterministic replication, repair, health checkpoints, and a REST API.
  image:
    src: /logo.svg
    alt: ADAMANT IPFS Node logo
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: What it is
      link: /guide/what-is-it
    - theme: alt
      text: Compare alternatives
      link: /guide/comparison
    - theme: alt
      text: View on GitHub
      link: https://github.com/Adamant-im/ipfs-node

features:
  - title: REST API for files
    details: Upload multipart files over HTTP and read them back by CID as a streamed attachment. Lifecycle status, upload policy, and storage metrics are readable without an API key; administrative routes require one.
    link: /reference/api
    linkText: API overview
  - title: Controlled peer topology
    details: Nodes talk over TCP with Noise and Yamux and run only identify and ping. There is no DHT, no mDNS, no relay, and no public gateway routing, which reduces public exposure of content-routing metadata without making a deployment private, anonymous, trustless, or censorship-proof.
    link: /guide/architecture
    linkText: Architecture
  - title: Bounded storage lifecycle
    details: Scheduled garbage collection releases unconfirmed uploads once they outlive their TTL, and evicts down to the low watermark when the blockstore passes the high watermark or free space falls into the disk reserve.
    link: /storage-lifecycle
    linkText: Storage lifecycle
  - title: Deterministic placement
    details: Rendezvous hashing ranks holders for every CID, so every node derives the same holder set without negotiating it. Age-based tiers ask for fewer copies as a file gets older.
    link: /storage-lifecycle
    linkText: How copies are placed
  - title: Repair and health checkpoints
    details: A scheduled repair cycle restores missing copies in bounded passes. The health endpoint reports a monotonic checkpoint height that advances only when every prerequisite passes, including peer attestations when they are required.
    link: /operations/monitoring
    linkText: Monitoring and health
  - title: Rate limits and admission control
    details: Per-endpoint address-based rate limits cover upload, pin, and read. Admission control bounds concurrent uploads and downloads, keeps a per-client download share, and refuses a request before any block is written.
    link: /guide/security
    linkText: Security and privacy
  - title: Container and source distribution
    details: Run the node as a container with one data volume and a mounted JSON5 configuration file, or build and run it from source on Node.js 24 under a process manager.
    link: /guide/docker
    linkText: Run with Docker
---

## Who it is for

- Applications that upload user files and fetch them back by CID over HTTP
- Developers who want a REST API instead of embedding an IPFS client library in every client
- Service operators who need bounded disk usage, explicit replication, and an operational health signal
- Self-hosters who want file storage on their own hardware, under their own configuration and peer list

## Where it is not the right tool

- Publishing content to the public IPFS network. The node runs no DHT, no public gateway, and no IPNS
- Fetching arbitrary CIDs from the public network. Retrieval is limited to the configured peer set
- Orchestrating an existing Kubo fleet. This is a standalone Helia service, not a Kubo API and not a cluster controller
- Anonymity or censorship resistance. A controlled topology reduces public exposure of content-routing metadata; it does not make a deployment private, anonymous, trustless, or censorship-proof

See [Comparison](/guide/comparison) for how the node relates to Kubo, IPFS Cluster, and object storage.

## Adopters

ADAMANT Messenger runs this node in production for attachment delivery, and its deployment is the
reference for the defaults shipped in the repository. The node itself is a general-purpose service:
the messenger is one adopter, not the reason the project exists. See
[ADAMANT Messenger](/guide/adamant-messenger) for what that deployment configures and why.

## Quick links

- [Quick start](/guide/quick-start) — get a node answering requests
- [Docker](/guide/docker) — container image, volume, and configuration mount
- [Configuration](/guide/configuration) — every option, default, and validation rule
- [API overview](/reference/api) — endpoint classes, authentication, and status codes
- [Storage lifecycle](/storage-lifecycle) — admission, garbage collection, replication, and repair
- [Monitoring and health](/operations/monitoring) — health states, checkpoint height, and metrics
