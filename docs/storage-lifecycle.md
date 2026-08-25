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
root filesystem. One reading of it is not a reservation, though: two uploads
that both see a gigabyte free would both be admitted and could cross the reserve
together. Each request therefore claims the bytes it may write — its declared
size, or the aggregate limit when it declares none — and the claim is counted
against free space until the request ends, in success or failure. A request is
admitted only when
`freeSpace - alreadyClaimed - requestSize >= storage.diskReserveBytes`.

Copies arriving from peers are uploads as far as the disk is concerned, so they
take the same claim and the same aggregate limit. Their size is measured in
blocks rather than in file content: the structural nodes of a DAG are fetched
and written like any other block, and a limit counting only what a reader would
see reads zero for a DAG whose content is empty and whose structure is
megabytes.

Counting is not enough on its own. Left to itself the UnixFS exporter requests
every block of a DAG before any of them completes — a 64 MiB file issues 65
reads up front — so by the time the first byte can be counted the whole DAG has
arrived, whatever the limit said. Intake therefore reads a bounded number of
blocks at a time, which is what makes the limit enforceable: measured against a
real node, an unbounded read pulls a 64 MiB file in full under a 4 MiB limit,
and a bounded one stops at 4 MiB.

What is left is the reads already in flight when the limit is crossed. They
still complete, so a transfer can exceed its limit by that many blocks; the disk
claim and the intake reservation both include exactly that much headroom, and
the whole block is charged rather than the part that was read. The overshoot is
covered, not merely small. Their concurrency is a quarter
of `storage.maxConcurrentUploads`, because a copy cannot declare its size and so
claims the aggregate limit for its whole transfer, and because refusing one
costs nothing a person can see: the sender still holds the file, and repair
places another copy on its next pass.

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

Pinning and lifecycle registration are one transaction for concurrency
purposes. Before changing either, a request locks every CID it contains in
lexical order and holds those locks through commit or rollback. Another upload,
confirmation, release, collector or handover therefore sees either the state
before the request or the state after it, never a pin from one side and a
registry record from the other. Ordering the locks also keeps two overlapping
multi-file requests from deadlocking.

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

Replication between nodes is not an HTTP route and uses no key at all. It runs
on the libp2p protocol `/adamant/replication/1.0.0`, where the handshake already
proves the calling peer id cryptographically. Nothing has to be distributed, and
a peer needs no HTTP address to be reachable.

Which peers may spend this node's disk is a policy, not a credential: today the
node accepts requests from the peers listed in `nodes`. That is still a closed
set, and it is the piece an uploader signature replaces so that anyone can run a
node without being handed a secret.

## Garbage collection

Collection applies three independent rules:

1. **Expiry.** A `temporary` file that outlived `expiresAt` is released,
   whatever the blockstore size is.
2. **Watermarks.** When the blockstore grows above
   `storage.gc.highWatermarkBytes`, the oldest unconfirmed files are released
   until the estimated size drops below `storage.gc.lowWatermarkBytes`. The gap
   between the two thresholds stops the collector from running on every tick.
3. **Handover.** A confirmed file whose copies belong on other nodes is released
   here once those nodes confirm they hold it. This is how an ageing file drops
   from four holders to two without ever losing durability; see
   [Replication and durability](#replication-and-durability).

### Releasing is not deleting

Losing a pin and losing the bytes are separate steps, and only the first one
follows from the rules above.

A released file stays on disk, unprotected. It keeps answering reads for free,
so a node that handed a copy over still serves it until something else needs the
space. Deleting it eagerly would only mean fetching it again over the network
later.

Blocks are deleted when space is actually short, which is either of:

- the blockstore grew above `storage.gc.highWatermarkBytes`, or
- free space on the volume fell into `storage.diskReserveBytes`

The second case matters on a disk smaller than the configured watermark, where
the ceiling would never be reached and the volume would fill instead. A report
says which of the two applied in its `trigger` field.

That pass also reclaims blocks cached while serving reads for content this node
does not hold, which is the only thing that bounds the read cache.

Confirmed files are never selected by the planner, and Helia never deletes a
pinned block. Before deleting anything, the collector verifies that every
confirmed file it holds is still protected and restores a missing pin first.

`storage.gc.enabled` controls the **scheduled** collector. It is on by default,
but frees no bytes while there is room: the collector releases what the rules
say, and reclaims blocks only under the pressure described above. The authorized
`POST /api/storage/gc` endpoint always runs on demand, `?dryRun=true` reports the
exact CIDs that would be released and retained without touching a block, and
`?force=true` frees them regardless of pressure.

The `removedCids` field of a collection report identifies blocks, not files. The
blockstore addresses content by multihash and rebuilds a CID with its own default
codec while listing, so an entry can read differently from the CID a file was
uploaded under.

Intake and pinning hold a process-level shared storage-operation lease from the
first block write or copy through registry commit or cleanup. Handover, storage
measurement, registry planning and dry runs stay outside the exclusive lease;
they do not delete blocks and may scale with the existing corpus. Only Helia's
destructive GC holds the exclusive lease, so it waits for every unpinned upload
to commit or finish cleanup without blocking new uploads during full scans.
Once deletion is queued, later intake waits behind it to prevent collection
starvation. Schedule long forced collections accordingly.

### What a run triggered by free space reclaims

The two triggers have different targets. A run above the high watermark evicts
until the blockstore estimate drops below the low watermark. A run caused by
free space falling into `storage.diskReserveBytes` evicts until the reserve is
honoured again with a 25% margin, because the watermarks say nothing about the
volume: on a disk whose blockstore is already below the low watermark, aiming at
the watermark would select nothing and reclaim not a byte while the disk stayed
full.

A run applies its plan only to records that still match it. The plan is made
from a snapshot, and an upload can re-register and confirm one of those CIDs
before the release reaches it; the record is re-read and the unpin performed with
nothing else touching the CID, so a file that gained a pin in the meantime keeps
it. `releasedCids` reports what was released rather than what was planned.

The same applies at the end of a run. Deleting blocks takes time, and a
re-upload during it can pin and register one of the released CIDs again; a
record is deregistered only while it is still the one this run released.

A collection that Helia could not complete keeps every record it released, and
reports `collected: false` with the failures in `errors`. Which file a surviving
block belongs to cannot be known — blocks are addressed by multihash and shared
between files — so the records stay for the next run to retry.

## Replication and durability

`replication.enabled` is `true` by default: placing copies needs no
configuration beyond the `nodes` list a node already has, and a durability
guarantee nobody switches on protects nothing.

A file is placed on a subset of the ADAMANT nodes. The peer pulls the DAG over
libp2p and pins it before answering, so an acknowledgement means the copy exists
and is protected there, not that a request was queued.

Turning it off with `replication.enabled: false` makes the node store content
**best effort** instead: one copy, on this node, pinned, with no promise that
any other node holds it. `GET /api/storage/policy` reports
`"mode": "best-effort"` so clients can see what they are getting. The node still
answers the protocol and still accepts copies from peers — a node that only took
part while it was also sending would have to be added to every other
configuration before it could be useful.

### How many copies, and where

Copies are **not** sent to every node. On a large node set that would cost
bandwidth and disk everywhere for no added durability. Copies are also not sent
to a random subset, because then no node could tell where a file is supposed to
live, and both repair and handover would need a network-wide search.

Instead the holders are derived from the CID with rendezvous hashing: each
candidate node is scored by `sha256(peerId ‖ cid)` and the highest scores win.
Two properties follow, and the rest of the design depends on both:

- Every node computes the same holders for a CID without asking anyone, so the
  set is agreed by construction rather than negotiated.
- Adding or removing a node moves only the fraction of CIDs it wins or loses,
  instead of reshuffling all of them the way a modulo assignment would.

How many holders a file gets depends on its **age**, through
`replication.placement`:

| File age            | Holders, including this node |
| ------------------- | ---------------------------- |
| Fresh               | 4                            |
| Older than 180 days | 3                            |
| Older than 365 days | 2                            |

Age is used rather than time of last access on purpose. Recording when a file
was last read would build a log of user activity, and sharing that log between
nodes so they could agree on it would spread the leak further. Creation time is
already implied by the upload, so it reveals nothing new.

When the network is no larger than the desired copy count, every node becomes a
designated holder, so the file goes to all of them. Asking for four copies on a
three-node network places three, and the fourth is simply not looked for: the
count is capped at the nodes that exist rather than retried against a node that
does not. Nothing is ever handed over in that state either, because there is
nowhere for a copy to move.

| Nodes | Desired copies | Holders        | Peers asked | Handover                            |
| ----- | -------------- | -------------- | ----------- | ----------------------------------- |
| 1     | 4              | 1              | 0           | never                               |
| 3     | 4              | 3, all of them | 2           | never                               |
| 4     | 4              | 4, all of them | 3           | never                               |
| 6     | 4              | 4              | 3 or 4      | allowed for the two outside the set |

### A node its peers do not know yet

A node accepts responsibility for a file only from a peer it has been
configured with, because storing content permanently is a cost somebody has to
have agreed to. A node that nobody has listed yet would therefore keep
everything uploaded to it in a single copy, which disappears with it.

So a peer that refuses responsibility is asked for something weaker instead: to
hold the blocks without pinning them. Because such a copy lasts only until its
node needs the space, the file is spread to a few more nodes than a pinned one
would be: several fragile copies outlive a single one. It can serve the file from then on, and it
promises nothing — the copy sits in the same tier as read cache and goes when
that node needs the space. Nothing is counted as durable that is not: an upload
report lists such peers under `cached`, separately from `replicas`, and the
acknowledged count ignores them.

This grants a stranger nothing it did not already have. Anyone who knows a CID
can already make a node fetch and cache those blocks by asking it to serve them;
this is the same effect with a different trigger, bounded by the same disk
reserve. What stays behind the configuration check is everything that makes a
node responsible: pinning, registration, and being counted as a holder.

Open is not the same as unbounded. A copy taken this way is charged to the peer
that asked for it, against a per-peer and a node-wide budget over the last hour.
The most a copy could cost is reserved before the first block is fetched and the
unused part is given back at the end: counting on completion instead would let
every concurrent request read the same figure and pass, and would charge nothing
at all to a peer that sends almost a whole copy and then aborts. The request
itself is charged and never refunded, because asking is most of the cost.

The hour is measured in six slices that expire one at a time rather than as a
counter reset on the hour, which would let a peer spend its whole allowance just
before the boundary and again just after it. A slice is kept until its end is an
hour old, so a charge counts for at least a full hour and at most seventy
minutes — over-counting rather than under-counting, which is the safe direction
for a limit. The node-wide budget is the one
that matters while peer identities are free to mint; both sit far above ordinary
traffic, where a node that just accepted an upload asks two peers to cache it.
Operator-facing transfer limits are separate work (#29).

It is a stopgap, not the answer. A file spread this way survives the loss of the
node it was uploaded to, but only until its peers need the space, and no repair
job will notice if the copies go. Node discovery removes the need for it.

Nothing has to be redone once the node becomes known. Repair already treats such
a file as under-replicated, so its next pass asks the same peers again, and this
time they accept responsibility. The blocks are already on those nodes, so
pinning them is a local operation: no file crosses the network a second time,
and no node has to be restarted for it.

### Handing a copy over

As a file ages its desired holder count shrinks, so nodes that are no longer
designated may release their copy. A node releases one only when **both** hold:

- it is outside the designated set for that CID, and
- every designated holder confirms over the protocol that it has the file.

The designated set is identical on every node, and a designated holder never
considers releasing. That is what prevents two nodes from dropping the last two
copies at the same moment, with no locking between them. If a designated holder
does not answer, or answers that it does not have the file, the copy stays where
it is and repair puts it where it belongs on the next pass.

Releasing a copy leaves the registry record in place with `heldLocally: false`:
the file is still durable in the network, this node simply stopped being one of
its holders.

### Reading a file

Routing stays the node's problem, not the client's. A client asks whichever node
it likes for a CID; if that node does not hold the file, it fetches the blocks
over bitswap and streams them on. This matters for the messenger, where the
sender and the receiver are usually on different nodes: the receiver learns the
CID as soon as the message arrives and asks its own node for it immediately,
long before any background job could have moved a copy there.

Bitswap asks the peers a node happens to be connected to. That is enough while
every node is connected to every other, and it stops being enough as soon as the
network outgrows the connection limit: a node connected to none of a file's
holders waits for `findFileTimeout` and answers `408`.

So before reading a CID it does not hold, a node opens connections to the nodes
that should hold it. It can name them because holders are derived from the CID,
and it does not need to know how old the file is: the holders of a file of any
age are a prefix of the same ranking, so the widest prefix any tier can ask for
covers all of them. The read then talks to a handful of named nodes instead of
depending on who happens to be connected.

Blocks fetched this way are written into the local blockstore, so the next read
of the same file is served locally instead of over the network again. They are
not pinned, which means they are reclaimed once space is short and not before.

A node that still cannot retrieve content answers `408` after `findFileTimeout`.
It never answers `404`, because it cannot know that content does not exist.

### Keeping the mesh connected

`@libp2p/bootstrap` dials its peers once, shortly after start, and never again.
Nothing else reconnects a peer that restarted or dropped, so a mesh quietly
comes apart over time. It is easy to miss, because uploads keep working: the
damage shows up later as slow retrieval and as replication that cannot place
copies.

The node therefore redials the peers in `nodes` that are not connected, once at
startup before the API starts serving and then on `peeringSchedule`. The work is
bounded by the size of `nodes`, which is the operator's own peer list, so it
never becomes network-wide dialling.

### Repair

The repair job (`replication.repairSchedule`, or `POST /api/storage/repair`)
lists confirmed files this node holds whose designated peers have not all
acknowledged, and places the missing copies again.

Replication needs the peers to be connected over libp2p, because the copy itself
travels by bitswap. Startup peering opens those connections before the API
starts serving, so the first upload after a restart already has somewhere to
place its copies.

A copy request that a peer cannot answer in time is reported as a shortfall
rather than failing the upload, and the repair job places the missing copies on
its next pass.

### Protocol version

Copies are placed over the libp2p protocol `/adamant/replication/1.0.0`. The
version in that identifier belongs to the wire format, not to the release: it
says what two nodes must agree on to talk to each other, and that changes far
less often than the software. Taking it from `package.json` would break
interoperability on every release for no reason.

Raise it when an older node can no longer read what a newer one sends — a new
required field, different framing, or an operation whose meaning changed. Adding
an operation that older nodes never send does not require it.

libp2p negotiates the newest version both ends offer, so listing an older one
alongside the current one is what allows a network to be upgraded one node at a
time. Only the current version is offered today, which means an upgrade has to
be applied everywhere: nodes on different versions cannot place copies on each
other. `GET /api/storage/metrics` reports the protocol a node speaks, so a mixed
deployment is visible rather than silent.

Messages are framed with a four byte length. The obvious alternative, treating
the end of the stream as the delimiter, requires the half-close to arrive
promptly, and when it does not both ends wait for each other until the call
times out.

### Why not Kubo with IPFS Cluster

Helia has no native pin-orchestration protocol. Cross-node pinning has to come
from somewhere, so the two realistic options are:

|                   | Helia with an explicit control plane (selected)                         | Kubo with IPFS Cluster                     |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Runtime           | The existing Node.js process                                            | A Go daemon plus a cluster daemon per node |
| Pin orchestration | A libp2p protocol between ADAMANT nodes, authenticated by the handshake | Raft or CRDT consensus inside the cluster  |
| Placement         | Rendezvous hashing over the CID, computed identically everywhere        | Allocation decided by the cluster          |
| Operational cost  | None beyond the current deployment                                      | New services, new state, new failure modes |
| Fit               | Small, fixed, mutually trusted node set                                 | Large or dynamic clusters                  |

The ADAMANT nodes already speak libp2p to each other, so the control plane costs
one protocol handler and no new runtime, credential, or port. **Helia-native
orchestration is therefore the selected durability model.** Kubo with IPFS Cluster remains the fallback if
the node set grows to a size where consensus-based pin allocation is worth its
operational cost.

## Storage report

`GET /api/storage/metrics` reports:

- `pinnedBytes` — content protected by a pin, estimated from the full DAG of
  each registered file, including blocks that existed before its latest upload
- `reclaimableBytes` — blockstore bytes that no pin protects
- `availableBytes` — free space on the blockstore filesystem
- `reservedBytes` and `usableBytes` — the disk reserve and what is left for uploads
- `files` — how many files are in each lifecycle state

A collection report also lists `demoted`: files whose local copy was handed over
to their designated holders during that pass.

Values are refreshed on the `diskUsageScanPeriod` schedule, because a directory
scan and a full registry sweep are too expensive for a request path. A subset is
also included in `GET /api/node/info`.

## Recovery and rollback

The scheduled collector is on by default, so read this before the first upgrade
rather than before enabling anything.

What it can delete with the shipped defaults is narrow. It never selects a
confirmed file this node holds, and with `storage.confirmationRequired` off no
upload ever expires, so the only unpinned blocks are read cache and content an
operator released on purpose. Content pinned before this release is protected
too: Helia never deletes a pinned block, and startup records those pins in the
registry so they appear in dry runs and in the storage report.

Deletion also waits for pressure. Nothing is freed until the blockstore passes
`storage.gc.highWatermarkBytes` or free space falls into
`storage.diskReserveBytes`.

### The first start after the upgrade

Startup walks the pinset once and records anything the registry does not know as
`confirmed`. It is idempotent, so a restart changes nothing, and a pin whose DAG
is not fully local is skipped rather than recorded — calling it confirmed would
claim more than the node can serve.

Which pins count as legacy is decided before the API accepts anything, by
listing the pinset once. Anything pinned after that belongs to a request with a
lifecycle of its own. Listing is cheap; reconciling each pin is not, which is
why only the first part is ordered against the listener.

Records are then created only while the CID is absent, and every
read-modify-write on the registry is serialised per CID. Both are needed:
without the snapshot the backfill could record a file between an upload pinning
it and registering it, and without the serialisation two writers could lose one
another's decision. Either would leave an operator who required confirmation
with a file that is durable and named by its CID.

It does not block the API. The walk is as long as the pinset, and holding reads
back for the whole migration would penalise exactly the nodes with the most to
serve. Reads, uploads and incoming copies do not need a complete registry; the
collector and the repair sweep are started once the walk finishes, so neither
acts on a half-built picture.

Two consequences are worth planning for:

- The original upload time is not recoverable, so a backfilled record is dated
  at the backfill. Every legacy file therefore counts as **fresh**, which is the
  widest tier: repair will place it on as many nodes as that tier asks for. On a
  small node list that means historical content is eventually copied to
  effectively every node. This is the durability guarantee arriving for content
  that never had it, not a fault, but it is real disk and real transfer on every
  node — plan capacity for the existing corpus, not just for new uploads.
- Repair works through a bounded, advancing batch per pass rather than the whole
  registry at once, so the copying is gradual. It is still the largest transfer
  the upgrade causes.

### Before the first collection

1. Run `POST /api/storage/gc?dryRun=true` and review `releasedCids`,
   `retainedCids`, and `demoted`. Nothing is unpinned and nothing is deleted by
   a dry run. It does ask peers whether they hold the files it would hand over,
   because a handover unpins a local copy and a plan without them is not the
   plan the real run follows. The sweep position is left where it was, so the
   real run starts on the same files.
2. Confirm that every CID that must survive appears in `retainedCids`. If a CID
   is missing, it is not confirmed: pin it with `POST /api/helia/pin/:cid` or
   confirm it with `POST /api/file/:cid/confirm` first.
3. Confirm `repairedPins` and `unprotected` are both empty. Either being
   non-empty means confirmed content had lost its pin. A run that cannot restore
   such a pin abandons itself before deleting anything, so an `unprotected` list
   is a signal to investigate, not a loss.
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

- Set `storage.gc.enabled` to `false` if the deployment wants deletion to be an
  explicit decision rather than a default; nothing else changes when it is off
- Keep the smallest tier of `replication.placement` at two copies or more, so a
  mistaken deletion on one node is recoverable from another
- Run the dry run again after changing the watermarks or the TTL
- Watch `GET /api/storage/metrics` for `gc.lastRun.errors` after each run

## Out of scope

Content encryption remains the responsibility of the ADAMANT client protocol.
This node stores and serves whatever bytes it is given.
