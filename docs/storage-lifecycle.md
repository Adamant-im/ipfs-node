# Storage lifecycle, garbage collection, and replication

This document describes how an ADAMANT IPFS node bounds its disk usage, what
happens to an uploaded file over time, and what durability the node promises.

Configuration lives in the `storage` and `replication` sections of the node
configuration file. Both sections are optional: every option has a documented
default, so a configuration file written before this feature keeps working. See
`config.default.json5`.

## Upload admission

An upload is refused before a single block reaches the blockstore when any of
these limits is exceeded.

| Limit                  | Option                         | Response |
| ---------------------- | ------------------------------ | -------- |
| Concurrent uploads     | `storage.maxConcurrentUploads` | `429`    |
| Aggregate request size | `storage.maxRequestSizeBytes`  | `413`    |
| Disk reserve           | `storage.diskReserveBytes`     | `507`    |
| Files per request      | `maxFileCount`                 | `400`    |
| Single file size       | `uploadLimitSizeBytes`         | `400`    |

The first three are checked by the upload guard before the multipart parser
runs. The last two are enforced by the parser itself through
`createMultipartLimits`, which aborts the request before handing an over-limit
part to the storage engine.

The aggregate size is checked twice: against `Content-Length` before parsing,
and against the bytes actually streamed, because a chunked request declares no
size.

Free space is measured on the filesystem that holds the blockstore, not on the
root filesystem. A request is admitted only when
`freeSpace - declaredRequestSize >= storage.diskReserveBytes`.

## Cleanup of failed uploads

Every upload request owns a session that records the blocks it created. Blocks
that already existed are not recorded, so a failing upload cannot delete content
that was stored earlier.

The session is committed only after every file of the request has been stored,
pinned, and registered. Any other outcome removes the recorded blocks:

- the parser rejected the request
- a file failed to import
- the route failed after some files were already imported
- the client disconnected mid-upload

A recorded block is deleted only when no other in-flight upload references it and
no pin protects it. Anything that survives cleanup is unpinned and therefore
reclaimable by the next collection.

Cleanup deletes through the file-backed blockstore rather than through the Helia
blockstore facade. The facade cancels a reprovide before deleting, and this node
registers no content routers on purpose, so a delete through it always fails.

## File states

| State       | Meaning                                 | Pinned | Reclaimable       |
| ----------- | --------------------------------------- | ------ | ----------------- |
| `temporary` | Accepted, not yet durable               | yes    | after `expiresAt` |
| `confirmed` | Durable                                 | yes    | never             |
| `expired`   | Released by TTL or by an explicit unpin | no     | yes               |

The state of every file this node accepted is stored in the node datastore under
the `/adm/files` prefix, so it survives a restart. `GET /api/file/:cid/status`
reports it.

`storage.confirmationRequired` decides which state an upload starts in:

- `false` (default): uploads are confirmed immediately. This is the behaviour the
  current ADAMANT client protocol expects, and no file expires on its own.
- `true`: uploads stay `temporary` until an authorized confirmation arrives, and
  an unconfirmed upload becomes reclaimable after `storage.temporaryTtlMs`.
  Enabling this is a protocol change: clients must call the confirm endpoint.

### Authorized transitions

These routes change durability and require the administrative key
(`adminApiKey`, sent as `x-api-key`):

- `POST /api/file/:cid/confirm` — `temporary` to `confirmed`
- `POST /api/file/:cid/unpin` — `confirmed` to `expired`
- `POST /api/helia/pin/:cid` — pin and register arbitrary content
- `POST /api/storage/gc`, `POST /api/storage/repair`

The guard fails closed. With no key configured the routes answer `503` rather
than being open, so a node cannot be filled with permanently pinned content by
an anonymous caller.

`POST /api/replication/:cid` is different: it is authorized by
`replication.token`, a secret shared by the ADAMANT nodes. A peer only ever asks
this node to store a copy, so distributing the administrative key across the node
set would grant far more than replication needs. Setting the token opens the
intake route on its own; `replication.enabled` only governs whether this node
pushes copies out.

## Garbage collection

Collection applies two independent rules:

1. **Expiry.** A `temporary` file that outlived `expiresAt` is released,
   whatever the blockstore size is.
2. **Watermarks.** When the blockstore grows above
   `storage.gc.highWatermarkBytes`, the oldest unconfirmed files are released
   until the estimated size drops below `storage.gc.lowWatermarkBytes`. The gap
   between the two thresholds stops the collector from running on every tick.

Released files lose their pin, then Helia deletes every unpinned block. That
pass also reclaims blocks cached while serving other peers.

Confirmed files are never selected by the planner, and Helia never deletes a
pinned block. Before deleting anything, the collector verifies that every
confirmed file is still protected and restores a missing pin first.

`storage.gc.enabled` controls the **scheduled** collector and is `false` by
default: deletion in production must be agreed with the maintainers first. The
authorized `POST /api/storage/gc` endpoint always runs on demand, and
`?dryRun=true` reports the exact CIDs that would be released and retained without
touching a block.

The `removedCids` field of a collection report identifies blocks, not files. The
blockstore addresses content by multihash and rebuilds a CID with its own default
codec while listing, so an entry can read differently from the CID a file was
uploaded under.

Collection takes the Helia blockstore write lock, so uploads wait while it runs.
Schedule it accordingly.

## Replication and durability

`replication.enabled` is `false` by default. The node then stores content
**best effort**: one copy, on this node, pinned, with no promise that any other
node holds it. `GET /api/storage/policy` reports `"mode": "best-effort"` so
clients can see what they are getting.

With replication enabled, a node that makes a file durable pushes it to the other
ADAMANT nodes listed in `nodes` that declare an `apiUrl`. The peer pulls the DAG
over libp2p and pins it before answering, so an acknowledgement means the copy
exists and is protected.

- `replication.factor` — copies that must exist, including this node
- `replication.ackQuorum` — acknowledgements required for an upload to be durable
- `replication.requireQuorumOnUpload` — when `true`, an upload that cannot reach
  the quorum is released and answered with `503`; when `false` (default) the
  upload succeeds, reports the shortfall, and the repair job converges later

The repair job (`replication.repairSchedule`, or `POST /api/storage/repair`)
lists confirmed files holding fewer copies than the factor requires and pushes
the missing ones again.

Replication needs the peers to be connected over libp2p, because the copy itself
travels by bitswap. Keep every replication peer in `peerDiscovery.bootstrap` as
well as in `nodes`.

### Why not Kubo with IPFS Cluster

Helia has no native pin-orchestration protocol. Cross-node pinning has to come
from somewhere, so the two realistic options are:

|                    | Helia with an explicit control plane (selected)                | Kubo with IPFS Cluster                     |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------ |
| Runtime            | The existing Node.js process                                   | A Go daemon plus a cluster daemon per node |
| Pin orchestration  | REST calls between ADAMANT nodes, authorized by a shared token | Raft or CRDT consensus inside the cluster  |
| Replication factor | Enforced by this node and by the repair job                    | Enforced by the cluster                    |
| Operational cost   | None beyond the current deployment                             | New services, new state, new failure modes |
| Fit                | Small, fixed, mutually trusted node set                        | Large or dynamic clusters                  |

The ADAMANT node set is small, fixed, and mutually trusted, and the project
already runs a REST API on every node. An explicit control plane covers the
requirement without adding a second runtime, so **Helia-native orchestration is
the selected durability model**. Kubo with IPFS Cluster remains the fallback if
the node set grows to a size where consensus-based pin allocation is worth its
operational cost.

## Storage report

`GET /api/storage/metrics` reports:

- `pinnedBytes` — content protected by a pin, estimated from the blocks this node
  wrote for each registered file
- `reclaimableBytes` — blockstore bytes that no pin protects
- `availableBytes` — free space on the blockstore filesystem
- `reservedBytes` and `usableBytes` — the disk reserve and what is left for uploads
- `files` — how many files are in each lifecycle state

Values are refreshed on the `diskUsageScanPeriod` schedule, because a directory
scan and a full registry sweep are too expensive for a request path. A subset is
also included in `GET /api/node/info`.

## Recovery and rollback

Read this before enabling `storage.gc.enabled` in production.

### Before enabling collection

1. Run `POST /api/storage/gc?dryRun=true` and review `releasedCids` and
   `retainedCids`. Nothing is deleted by a dry run.
2. Confirm that every CID that must survive appears in `retainedCids`. If a CID
   is missing, it is not confirmed: pin it with `POST /api/helia/pin/:cid` or
   confirm it with `POST /api/file/:cid/confirm` first.
3. Confirm `repairedPins` is empty. A non-empty list means confirmed content had
   lost its pin, which must be understood before deleting anything.
4. Back up the datastore directory. It holds the pinset and the lifecycle
   registry, which are what protects content from deletion.

### Rolling back

- **Disable collection**: set `storage.gc.enabled` to `false` and restart. The
  scheduled collector stops; nothing else changes.
- **Undo a release before collection runs**: a released file is unpinned but its
  blocks are still on disk. `POST /api/helia/pin/:cid` restores the pin and
  registers the file as confirmed again.
- **Recover content already deleted**: the blocks are gone from this node. Re-pin
  the CID with `POST /api/helia/pin/:cid` while a peer that still holds it is
  connected, and the DAG is pulled back over libp2p. Verify with
  `GET /api/file/:cid` afterwards. If no node holds the content any more, it can
  only be restored by re-uploading the original file.
- **Restore the datastore backup**: stop the node, replace the datastore
  directory, and start it again. Pins and lifecycle records return to the state
  of the backup; blocks deleted since then still have to be re-fetched as above.

### Operational safeguards

- Keep `storage.gc.enabled` false until a deletion policy is agreed
- Keep `replication.factor` at two or more, so a mistaken deletion on one node is
  recoverable from another
- Run the dry run again after changing the watermarks or the TTL
- Watch `GET /api/storage/metrics` for `gc.lastRun.errors` after each run

## Out of scope

Content encryption remains the responsibility of the ADAMANT client protocol.
This node stores and serves whatever bytes it is given.
