---
title: Upgrades and rollback
description: How to stop the node cleanly, upgrade a source or container deployment, roll a fleet, and roll back safely.
---

# Upgrades and rollback

An upgrade touches persistent state, so the order matters. Read
[Persistent state and backups](/operations/persistence) first; a current backup is the only
rollback that always works.

## Before upgrading

- Take a backup of the store directory, or a snapshot of the data volume
- Read the release notes for the target version
- Run `POST /api/storage/gc?dryRun=true` and confirm that every CID which must survive appears in
  `retainedCids`, and that `repairedPins` and `unprotected` are empty
- Note the current `peerId` and `membership.version`, so a change afterwards is visible
- Plan capacity: the first start after an upgrade can copy a large amount of historical content
  between nodes, as described below

## Graceful shutdown

`SIGINT` and `SIGTERM` are each handled once. On receipt the node:

1. Logs `Received SIGTERM, shutting down`
2. Stops the disk-usage, peering, garbage-collection, and admission-recovery jobs
3. Begins stopping replication repair and the health service
4. Arms two timers: idle HTTP connections are force-closed at 12 s, and a hard deadline fires at 15 s
5. Closes the HTTP server, letting in-flight requests finish
6. Waits for the background jobs, stops Helia, and exits with code `0`

If the hard deadline fires first, the node logs `Shutdown timed out` and exits with code `1`.

Any supervisor or container stop timeout must therefore outlast 15 s. Give it at least 20 s:
`TimeoutStopSec=30` in systemd, `--stop-timeout 20` for `docker run`, `stop_grace_period: 20s` in
Compose. A shorter budget risks `SIGKILL` while persistent state is still being written.

## Upgrading from source

```bash
sudo systemctl stop ipfs-node
git -C /opt/ipfs-node fetch --tags
git -C /opt/ipfs-node checkout <tag>
cd /opt/ipfs-node
nvm use
npm ci
npm run build
sudo systemctl start ipfs-node
```

`npm ci` must run install scripts: the WebRTC transport package pulls a native module whose prebuilt
binary is downloaded during installation, and a tree installed with `--ignore-scripts` fails at
startup.

Review the configuration file against [Configuration](/guide/configuration) before starting.
Unknown keys are ignored, so a removed option does not fail the start — it simply stops doing
anything.

## Upgrading a container

```bash
docker pull ghcr.io/adamant-im/ipfs-node:<version>
docker stop --timeout 20 ipfs-node
docker rm ipfs-node
docker run -d --name ipfs-node ... ghcr.io/adamant-im/ipfs-node:<version>
```

Keep the same `/data` volume and the same mounted configuration file. The container is replaceable;
the volume is the node. Pin an immutable version tag rather than tracking `latest`, so a rollback is
a matter of naming the previous tag.

With Compose, change the image reference and run `docker compose up -d`.

## The first start after an upgrade

Startup walks the pin set once and records anything the registry does not know as `confirmed`. The
walk is idempotent, and a pin whose DAG is not fully local is skipped rather than recorded.

It does not block the API. Reads, uploads, and incoming copies do not need a complete registry; the
collector and the repair sweep start only once the walk finishes, so neither acts on a half-built
picture.

Two consequences are worth planning for:

- The original upload time is not recoverable, so a backfilled record is dated at the backfill.
  Every legacy file therefore counts as **fresh**, which is the widest placement tier: repair will
  place it on as many nodes as that tier asks for. On a small node list that means historical
  content is eventually copied to effectively every node. This is the durability guarantee arriving
  for content that never had it, but it is real disk and real transfer on every node
- Repair works through a bounded, advancing batch per pass, so the copying is gradual. It is still
  the largest transfer the upgrade causes

The same startup phase clears admission tokens left by a request that can no longer resume.

## Rolling a fleet

The replication protocol offers only its current version, and libp2p negotiates the newest version
both ends support. With one entry in the list, nodes on different versions cannot place copies on
each other, so a partially upgraded fleet has reduced durability until it is finished.

`GET /api/storage/metrics` reports the protocol each node offers under `replication.protocol`, which
is what makes a half-upgraded network visible rather than silent.

Sequence:

1. Set `health.requiredPeerCount: 0` on the nodes being upgraded first, so a node ahead of its peers
   does not freeze its checkpoint waiting for attestations it cannot get
2. Upgrade one node at a time, confirming `state: ready` and an unchanged `peerId` before moving on
3. Once every node is upgraded, raise `health.requiredPeerCount` again and restart
4. Confirm that heights advance on every node and that `membership.version` matches across the fleet

While `requiredPeerCount` is `0`, `checks.peerAttestations` is always true and network coverage is
unverified. Treat that window as unverified for routing decisions that depend on it.

Changing the `nodes` list at the same time compounds the problem: it changes the membership epoch
and resets every persisted checkpoint, so `height` returns to `0` fleet-wide. Do membership changes
and version upgrades in separate steps.

## Rolling back

In increasing order of disruption:

- **Disable scheduled collection.** Set `storage.gc.enabled: false` and restart. The scheduled
  collector stops; nothing else changes
- **Undo a release before collection runs.** A released file is unpinned but its blocks are still on
  disk. `POST /api/helia/pin/:cid` restores the pin and registers the file as confirmed again
- **Roll back the software.** Check out the previous tag and rebuild, or run the previous immutable
  container tag against the same volume. Downgrading is safe only when the persistent formats did
  not change in the version being left; the release notes are the authority
- **Recover content already deleted.** Re-pin the CID with `POST /api/helia/pin/:cid` while a peer
  that still holds it is connected, and the DAG is pulled back over libp2p. Verify with
  `GET /api/file/:cid`
- **Restore the store backup.** Stop the node, replace the directory, start it again. Pins and
  lifecycle records return to the state of the backup; blocks deleted since then still have to be
  re-fetched

## Version and tag alignment

One number identifies a release everywhere:

- `version` in `package.json`
- the Git tag `vX.Y.Z`
- the GitHub Release
- the container tag `ghcr.io/adamant-im/ipfs-node:X.Y.Z`

The publish workflow refuses a release whose tag does not match `package.json`, and refuses a tag
that is not an ancestor of the `dev` branch. Every release publishes its immutable version tag; a
stable release also moves `latest`; a prerelease publishes its version tag only, so `latest` never
points at one.

The documentation site is built from the default branch and from published releases, so it tracks
the same source.

The project is pre-1.0, and no release has been published yet. Take the exact version to pin from
the [releases page](https://github.com/Adamant-im/ipfs-node/releases) rather than from an example
in this documentation.
