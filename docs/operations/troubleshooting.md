---
title: Troubleshooting
description: Symptom-driven diagnosis for startup failures, health that never reaches ready, rejected uploads, download timeouts, replication, and container problems.
---

# Troubleshooting

Each entry names a symptom, the likely cause, and the check that confirms it.

## The process will not start

**A message like `Invalid config: "storage.gc.lowWatermarkBytes" must be lower than storage.gc.highWatermarkBytes`.**
Configuration validation aborts the process and names the failing field. Fix that field. The full
list of rules is in [Configuration](/guide/configuration).

**`Cannot read config file /app/config.json5` or the same path outside a container.**
The file is read from the repository root, located by walking up from the compiled entry point to
the nearest `package.json`. Confirm the file exists at that path, and that `IPFS_NODE_CONFIG` or the
first CLI argument names the suffix you intended: both select `config.<name>.json5`.

**`Cannot parse config file ...`.**
The file is JSON5, so comments and trailing commas are allowed, but the message names the parse
position. A common cause is an unterminated string or a missing brace after hand-editing.

**`adminApiKey must be an empty value or a unique secret of at least 32 characters`.**
The key is shorter than 32 characters, or it is one of the known placeholder values the validator
refuses. Generate a real one with `openssl rand -hex 32`. Leaving it empty is valid and makes
administrative routes answer `503`.

**`health.requiredPeerCount cannot exceed the number of configured remote peers`.**
The bound is `nodes.length - 1`. A single-node deployment must use `0`. Removing a peer from `nodes`
may require lowering this value in the same change.

**`nodes[N].multiAddr must contain a /p2p/<peer-id> component`, or a duplicate-peer message.**
Every entry needs a full multiaddr ending in `/p2p/<peer-id>`, and no two entries may resolve to the
same peer id.

**`cors.allowedOrigins must be a non-empty array`.**
The key is required. A configuration migrated from `cors.origin` or `cors.originRegexps` fails here
until it is rewritten; see the migration section of [Configuration](/guide/configuration).

## Health never reaches ready

Read `checks` in `GET /api/node/health`; the failing entry names the cause.

| Failing check           | Cause                                                                                                                                                                                                                                              | Check                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `startupReconciliation` | Registry backfill or admission recovery reported errors                                                                                                                                                                                            | Look for `Registry backfill:` or `Admission recovery:` warnings in the log                                         |
| `storageFresh`          | No storage measurement inside `health.storageMaxAgeMs`                                                                                                                                                                                             | Confirm `diskUsageScanPeriod` is more frequent than that window and that the scan is not erroring                  |
| `storageReserve`        | Free space has fallen into `storage.diskReserveBytes`                                                                                                                                                                                              | `GET /api/storage/metrics`; free space or lower the reserve deliberately                                           |
| `repairFresh`           | No complete cycle inside `health.repairMaxAgeMs`, or too many consecutive unsuccessful cycles (`replication.consecutiveUnsuccessfulCycles` above `health.repairBacklogGraceCycles`; a non-zero file backlog alone is not enough when grace is set) | `GET /api/node/health` `replication.consecutiveUnsuccessfulCycles`, `replication.backlog`, and `replication.ageMs` |
| `peerAttestations`      | Fewer peers attested than `health.requiredPeerCount`                                                                                                                                                                                               | Confirm the peers are connected, upgraded, and share the same `membership.version`                                 |
| `clockConsistent`       | The host clock moved behind a recorded observation                                                                                                                                                                                                 | Check NTP; advancement resumes once the clock catches up                                                           |
| `helia`                 | The Helia node is not started                                                                                                                                                                                                                      | Read the startup log                                                                                               |

**The state is `ready` but `height` stays `0`.**
The membership epoch changed. Changing `nodes` resets the persisted checkpoint, so height restarts
from `0` for the new epoch. Compare heights only between nodes reporting the same
`membership.version`.

**Two healthy nodes report heights one interval apart.**
Expected at a round boundary: peers may attest an adjacent round.

**A node was upgraded ahead of its peers and stays `degraded`.**
That is the fail-safe result. Set `health.requiredPeerCount: 0` on the transitioning fleet and raise
it once every required peer is upgraded; see [Upgrades and rollback](/operations/upgrades).

## The app shows the node offline while probes succeed

`curl` and a Zabbix or container probe call the API with no `Origin` header. CORS does not apply,
so `GET /api/node/health` can report `ready` while a browser or desktop renderer never sees the
body. `fetch` and axios then surface a network error, and the client shows the node offline.

Check the origin the client actually sends:

- A PWA or other web app sends `https://<page-host>`. It must match an entry in
  `cors.allowedOrigins` on scheme, host, and port. `https://*.example.org` does not match
  `http://`, a different port, or the bare `https://example.org`.
- The official ADAMANT Electron build sends `Origin: app://.`. Other Electron builds send
  `app://localhost` or `app://<host>` when they load pages from that host. The entry has to be
  exact, and it is commented out until an operator adds it. A web wildcard does not cover it.
- Confirm with `curl -D - -H 'Origin: app://.' https://<host>/api/node/info`. A working desktop
  origin answers `Access-Control-Allow-Origin: app://.`. A missing header with HTTP 200 is this
  failure. Injecting the header in the client hides it only until every node the client uses lists
  the origin.

The same miss fails `POST /api/file/upload`. Clients that retry across nodes and then show a generic
"failed to upload" message are often aggregating these network errors. This repository does not
emit that client string. Read the node response, or the `curl` check above, before raising rate
limits.

`GET /api/node/health` staying `degraded` is a different fault. The probe is then telling the truth;
read `checks` in the health body. A desktop CORS failure does not change `state`.

## Uploads are rejected

Operational failures on the upload and read paths include a stable `code` next to `error`. Branch
on `code`. The full list is in [API overview](/reference/api).

| Status | `code`                 | Cause                                                                                | Action                                                                                                                       |
| ------ | ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `no_file`              | No file part was sent                                                                | Send one or more `files` parts                                                                                               |
| `400`  | `too_many_files`       | More files than `maxFileCount`                                                       | Stay within the limit                                                                                                        |
| `400`  | `file_too_large`       | One file is over `uploadLimitSizeBytes`                                              | Stay within the per-file limit                                                                                               |
| `400`  | `multipart_fields`     | A non-file text field was sent                                                       | Send `files` parts only                                                                                                      |
| `413`  | `request_too_large`    | Combined size over `storage.maxRequestSizeBytes`                                     | Raise the limit or split the request; the check runs against `Content-Length` before parsing                                 |
| `429`  | `rate_limited`         | Upload rate window exceeded. Default is 10 requests per 900000 ms per client address | Wait for `Retry-After`. If every client shares one bucket, fix `trustProxy` before raising the limit                         |
| `429`  | `upload_concurrency`   | `storage.maxConcurrentUploads` slots are full                                        | `Retry-After: 5`. Compare `concurrency.uploads` on `GET /api/node/details` with the limit                                    |
| `503`  | `replication_quorum`   | `replication.requireQuorumOnUpload` is on and the quorum was not reached             | Check peer connectivity; the upload was rolled back cleanly                                                                  |
| `507`  | `insufficient_storage` | The request would consume `storage.diskReserveBytes`                                 | Free space, lower the reserve, or collect garbage with `POST /api/storage/gc?force=true`                                     |
| `500`  |                        | Storage or replica settlement failed                                                 | Not a clean rejection. The content may be partially durable; re-uploading is safe because content-addressed dedup absorbs it |

**Ten uploads fail in a row and the client stops.**
The default upload window is 10 requests per 15 minutes for one client address. Eleven rapid
uploads from that address produce `429` / `rate_limited` on the eleventh, with `Retry-After` and
`RateLimit` headers. Ten failures can also be ten CORS or connection errors that never reached this
counter. A shared address makes the window a deployment-wide budget: with `trustProxy: false`
behind nginx, every client is the proxy. The startup log warns about that. Set hop count `1` or
the proxy CIDR, on a test network the same way as on a public deployment. Do not set `true`.

**The upload never returns a status.**
Admission answers `507` when the disk reserve would be consumed, and `429` / `upload_concurrency`
when the in-flight slots are full. A request that sits with no status is not one of those
refusals. The process does not cap its own memory; the host cgroup or service limit does. A
blockstore scan on `diskUsageScanPeriod` shares the disk with uploads, and a node whose
`storageFresh` check is failing is already late on that scan. Check host memory and disk wait, and
`checks.storageFresh` on `GET /api/node/health`, before treating the hang as a client bug.

**A proxy rejects the upload before the node sees it.**
Set the proxy body limit at or below `uploadLimitSizeBytes` and disable request buffering for the
upload path. An nginx example is in [Installation](/guide/installation).

## Downloads time out

`408` with `code` `file_timeout` is the only timeout answer, and three separate deadlines can
produce it: discovery bounded by
`findFileTimeout`, a stalled transfer bounded by `downloadIdleTimeout`, and a size-aware complete
deadline derived from `downloadMinBytesPerSecond` and capped by `downloadMaxDurationMs`. A failing
request may spend more than one `findFileTimeout` before answering.

Likely causes:

- No connected peer holds the content. Check `GET /api/libp2p/peers` and the peering log. Bootstrap
  dials once, so `peeringSchedule` is what keeps the mesh together after a restart
- A libp2p TCP session is up while bitswap or replication is not. Look for `peering_liveness_failed`
  or `peer_session_recovery` in the log. The peering job pings connected configured peers and
  resets those that miss the ping; a session that still answers ping is left in place.
- The CID exists only on the public IPFS network. This node registers no content routing and will
  never find it
- The content was released and its blocks were reclaimed on every holder

The node never answers `404` for a CID it cannot retrieve, because it cannot know whether the
content exists elsewhere. A `404` on this API means an unknown registry record or an unrouted path.

A client that just uploaded can still see `408` / `file_timeout` on the node it did not upload to.
That is replication lag or a peer that does not hold the CID yet, not a failed upload. Check
`GET /api/file/:cid/status`, `replication` on `GET /api/node/health`, and whether repair is behind
(`repairFresh`, `replication.backlog`). Raising `findFileTimeout` waits longer for the same lookup;
it does not place a missing copy.

## The process exits with `Cannot find module node_datachannel.node`

Helia depends on `@libp2p/webrtc`, which loads the `node-datachannel` native binary at import time.
The binary is downloaded during `npm ci`, not during `npm run build`. npm 12 skips that download
unless `package.json` `allowScripts` names the package; this repository already lists it.

Typical causes:

- `npm ci --ignore-scripts` was used on a tree that has to start
- `node_modules` was copied from a host that never ran the install script
- the installer reached the npm registry but not GitHub releases, where the prebuild lives
- a lockfile change introduced a new install script and `strict-allow-scripts` was not yet in
  `.npmrc`, so npm 12 skipped `node-datachannel` silently

Delete `node_modules`, run a normal `npm ci` that can reach GitHub releases, and confirm
`node_modules/node-datachannel/build/Release/node_datachannel.node` exists before starting. If
`npm ci` lists skipped install scripts, run `npm install-scripts ls` and approve only what this
project needs, as described in [Contributing](/guide/contributing).

## Replication never places copies

- `replication.enabled` is `false`. The node then stores content best effort, one local copy, and
  `GET /api/storage/policy` reports `"mode": "best-effort"`
- The peers are not connected. Copies travel over libp2p, so the connection has to exist first
- The peers run a different replication protocol version. Compare `replication.protocol` from
  `GET /api/storage/metrics` on each node; nodes on different versions cannot place copies on each
  other
- This node is not listed in the peers' `nodes`. Durable placement is accepted only from configured
  peers, so an unlisted node is offered the weaker unpinned `cache` operation instead and its
  content stays in one durable copy
- The network is no larger than the desired copy count. `networkTooSmall` in the upload report says
  so: asking for four copies on a three-node network places three, and the fourth is not looked for

## Rate limiting behaves unexpectedly

**Every client shares one bucket.**
`trustProxy` is `false` behind a reverse proxy, so Express uses the socket address, which is the
proxy. The process logs a warning about this at startup. Configure the exact proxy addresses or
CIDRs. Do not set `true` — it is rejected, because a client could then spoof `X-Forwarded-For`.

**The configured limit seems higher than expected.**
Limiter state is in memory per process. A restart clears it, and a second process or host keeps its
own counters, so the effective limit is per process. Enforce rates at the proxy as well for any
multi-process deployment.

**A `429` with no obvious rate abuse.**
Read `code`. `rate_limited` is the window and carries `Retry-After` plus `RateLimit` headers.
`upload_concurrency`, `download_concurrency`, and `download_client_concurrency` are admission:
`Retry-After: 5`, and `GET /api/node/details` shows occupancy under `concurrency`. The window
limiter runs first, so its `RateLimit` headers can still be present on an admission `429`. An empty
limiter with `rate_limited` from many users at once is a shared client address; see the upload
section above.

## Disk fills up

Garbage collection frees blocks only under pressure: when the blockstore passes
`storage.gc.highWatermarkBytes`, or when free space falls into `storage.diskReserveBytes`. Below
both thresholds it reclaims nothing, by design.

- Confirmed files this node holds are never selected. If the disk is full of confirmed content, the
  answer is more disk or a different placement policy, not the collector
- `POST /api/storage/gc?dryRun=true` reports exactly what would be released and retained without
  touching a block
- `POST /api/storage/gc?force=true` collects even below the high watermark
- `storage.gc.enabled: false` disables only the scheduled collector; the endpoint still works
- On a disk smaller than the configured watermark the ceiling is never reached, and the disk-reserve
  trigger is what protects the volume. Check that `diskReserveBytes` is realistic for the volume

Watch `gc.lastRun.errors` in `GET /api/storage/metrics` after each run.

## The peer identity changed

The node started against an empty store directory. It generated a new libp2p private key, and every
other operator's `nodes` entry for it no longer matches, so replication and health attestations do
not reach it.

Check the resolved path: it is `$HOME/<storeFolder>` for the process user, so a changed `HOME`, a
changed service user, or a missing volume all produce this. Stop the node, restore or re-mount the
original directory, and start again. See
[Persistent state and backups](/operations/persistence).

## Container-specific problems

**The container exits immediately.**
Almost always a configuration error. `docker logs` carries the validation message. Confirm the file
is mounted at `/app/config.json5`; the image ships none.

**`EACCES` writing the store.**
A host bind mount whose directory is not owned by uid 1000. `chown -R 1000:1000` it before the first
start. A named volume is initialized from the image and needs no such step.

**A new peer identity after recreating the container.**
The `/data` volume was not reused. `HOME` is `/data` in the image, so the store is
`/data/<storeFolder>`; without that volume every start is a first start.

**The container is marked unhealthy while starting.**
The bundled check treats only `ready` as healthy, and the start period covers startup
reconciliation, the first disk scan, and the first checkpoint. Widen with
`IPFS_NODE_HEALTHCHECK_STATES` only when a deployment deliberately accepts a node whose
prerequisites currently fail.

**Shutdown is not graceful.**
The stop timeout is shorter than the 15 s internal deadline. Use `--stop-timeout 20` or
`stop_grace_period: 20s`. See [Docker](/guide/docker).
