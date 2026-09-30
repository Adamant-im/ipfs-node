---
title: Persistent state and backups
description: What the node stores, where it lives, and how to back up, restore, and move it without losing peer identity or content.
---

# Persistent state and backups

Everything durable the node owns lives in one directory. Treat it as a single consistency unit:
peer identity, pins, lifecycle registry, repair evidence, and the health checkpoint describe each
other, and restoring a subset of them produces a node that misreports its own state.

## What is persistent

| State                            | Stored in                                  | Losing it costs                                                        |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Content blocks                   | `blockstore/`                              | The bytes, unless a peer still holds them                              |
| libp2p private key               | `datastore/` at `/pkcs8/self`              | The peer identity; every other operator's `nodes` entry stops matching |
| Helia pin set                    | `datastore/`                               | Protection from garbage collection                                     |
| File lifecycle registry          | `datastore/` under `/adm/files`            | Storage reporting, dry runs, and repair coverage for those files       |
| Pin-intent markers               | `datastore/` under `/adm/pin-intent`       | The ability to tell a crashed upload from legacy content               |
| Health checkpoint                | `datastore/` at `/adm/health/checkpoint`   | Checkpoint height; the node restarts the epoch from `0`                |
| Repair cursor and cycle evidence | `datastore/` at `/adm/health/repair-cycle` | Repair progress; the next cycle starts over and publishes no coverage  |

## Where it lives

The store path is `$HOME/<storeFolder>`, where `storeFolder` comes from the configuration file and
the home directory is that of the process user. With the shipped `storeFolder: '.adm-ipfs'` a node
running as `ipfs-node` with `HOME=/var/lib/ipfs-node` keeps its data in
`/var/lib/ipfs-node/.adm-ipfs`, holding `blockstore/` and `datastore/`. Both are created at startup
if they are missing.

Because the path is derived from `HOME`, a service manager that changes the environment changes
where the data goes. Pin `HOME` explicitly in the unit or the container rather than relying on a
default; see [Installation](/guide/installation) and [Docker](/guide/docker).

An optional absolute `dataDir` that would decouple the store from `HOME` is open work in [issue #30](https://github.com/Adamant-im/ipfs-node/issues/30)
and is not implemented.

## Backing up

Back up the whole store directory as one unit.

```bash
sudo systemctl stop ipfs-node
sudo tar --create --gzip \
  --file /backup/ipfs-node-$(date +%F).tar.gz \
  --directory /var/lib/ipfs-node .adm-ipfs
sudo systemctl start ipfs-node
```

Points worth planning for:

- A stopped node gives a consistent copy. A filesystem or volume snapshot of a running node is
  crash-consistent, which the stores tolerate, but a `tar` of a live directory can capture a
  half-written record
- A datastore-only backup preserves what is pinned and what the registry knows, but not the blocks.
  It is useful, and it is not a restore
- The backup contains the libp2p private key. Protect it like any other secret
- The configuration file holding `adminApiKey` lives outside the store directory; back it up
  separately and with the same care

## Restoring

```bash
sudo systemctl stop ipfs-node
sudo rm -rf /var/lib/ipfs-node/.adm-ipfs
sudo tar --extract --gzip \
  --file /backup/ipfs-node-2026-09-04.tar.gz \
  --directory /var/lib/ipfs-node
sudo chown -R ipfs-node:ipfs-node /var/lib/ipfs-node/.adm-ipfs
sudo systemctl start ipfs-node
```

Verify afterwards:

```bash
curl -s -H "x-api-key: $KEY" http://127.0.0.1:4000/api/node/details   # peerId unchanged
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/file/<known-cid>
curl -s http://127.0.0.1:4000/api/node/health                          # state and height
```

Pins and lifecycle records return to the state of the backup. Blocks deleted since then have to be
re-fetched from a peer that still holds them.

## Moving a node to another host or volume

1. Stop the node.
2. Copy the whole store directory, preserving ownership and permissions
   (`rsync -aHAX`, or `tar` as above).
3. Make sure the process user on the target resolves to the same `HOME`, and that
   `storeFolder` is unchanged. The resolved path must be the same, or the node will not find the
   data.
4. Fix ownership on the target so the process user owns every file.
5. Start the node and confirm the `peerId` is unchanged and a known CID still downloads.
6. Only then decommission the source.

Starting against an empty directory is the failure mode to guard against: the node comes up
cleanly, generates a new peer identity, and reports every existing CID as unretrievable — a `408`,
not a `404`. Nothing warns about it, because a first start looks exactly the same.

To roll back, stop the new node, start the old one against its untouched directory, and revert any
`nodes` entry that was changed. Keep the source intact until the target has been verified.

## Losing the datastore

| Situation                               | Recoverable                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Datastore lost, blockstore intact       | The blocks are still on disk but unpinned and unregistered, so the collector may reclaim them. The node has a new peer identity                           |
| Blockstore lost, datastore intact       | Pins and records survive. Re-pin each CID with `POST /api/helia/pin/:cid` while a peer that holds it is connected, and the DAG is pulled back over libp2p |
| Both lost, peers still hold the content | Restore from a peer by re-pinning, after distributing the node's new `multiAddr` to every other operator                                                  |
| Both lost, no peer holds the content    | Not recoverable. Only re-uploading the original file restores it                                                                                          |

After any identity change, every other node's `nodes` entry for this node is wrong: replication and
health attestations will not reach it until they are updated.

## Containers

The image pins `HOME=/data` and declares `/data` as a volume, so one volume holds the whole store —
`/data/.adm-ipfs` with the default `storeFolder`.

- A named volume is initialized from the image, where `/data` is owned by uid 1000, so ownership is
  correct with no extra step
- A host bind mount is not. Create the directory and `chown -R 1000:1000` it before the first start,
  or the process cannot write its stores
- Replacing the container while keeping the volume preserves identity, pins, and content. This is
  verified by `scripts/docker-smoke-test.sh`
- Back up a named volume by running a throwaway container that mounts it read-only and writes an
  archive to a bind-mounted directory

Losing the volume is the container form of losing the store directory, with the same consequences.
