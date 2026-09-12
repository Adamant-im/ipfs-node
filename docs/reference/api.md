---
title: API overview
description: The REST contract of the node — authentication, worked examples, status codes, and where the machine-readable specification lives.
---

# API overview

The stable client, lifecycle, and node-health contract is described here with worked examples. The
generated per-operation tables are on [Endpoint reference](/reference/endpoints), and the
machine-readable document is [`openapi.yaml`](/openapi.yaml).

Examples use `https://ipfs.example.org`, which stands for a reverse proxy in front of the node. The
process itself serves plain HTTP; see [Security and privacy](/guide/security).

## Contract and versioning

`docs/openapi.yaml` covers the routes an application and an operator depend on. Low-level Helia and
libp2p routes and the optional debug route are deliberately outside it — they are operator tools
whose shape may change with the runtime.

The `version` field in `GET /api/node/health`, `GET /api/node/info`, and `GET /api/node/details`
is the `version` from `package.json`. It is the software version, not the contract version, and it
is unrelated to the libp2p replication protocol version reported by
`GET /api/storage/metrics`.

## Authentication

There is one credential: the administrative key, sent as the `x-api-key` header and compared in
constant time against `adminApiKey`.

| Class                | Routes                                                                                                                                                                           | Requirement                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Public               | `GET /`, `GET /api/node/health`, `GET /api/node/info`                                                                                                                            | None                                         |
| Public file transfer | `POST /api/file/upload`, `GET /api/file/:cid`                                                                                                                                    | None; rate, size, and admission limits apply |
| Public storage state | `GET /api/file/:cid/status`, `GET /api/storage/metrics`, `GET /api/storage/policy`                                                                                               | None                                         |
| Administrative       | `GET /api/node/details`, `POST /api/file/:cid/confirm`, `POST /api/file/:cid/unpin`, `POST /api/storage/gc`, `POST /api/storage/repair`, all `/api/helia/*`, all `/api/libp2p/*` | `x-api-key`                                  |
| Disabled by default  | `GET /api/debug/autopeering`                                                                                                                                                     | `enableDebugApi: true` and `x-api-key`       |

A missing or wrong key answers `401`. An unset `adminApiKey` answers `503 Service not configured`,
so administrative routes fail closed rather than open. There is no end-user identity or session
layer.

`GET /` answers with the plain text `IPFS node`.

## Upload a file

Send one or more multipart parts named `files`. Text fields are rejected with `400`.

```bash
curl --fail-with-body \
  --form 'files=@file.txt' \
  https://ipfs.example.org/api/file/upload
```

```json
{
  "filesNames": ["file.txt"],
  "cids": ["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"],
  "files": [
    {
      "cid": "bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm",
      "name": "file.txt",
      "state": "confirmed",
      "expiresAt": null,
      "replication": {
        "mode": "quorum",
        "desiredCopies": 4,
        "copies": 3,
        "required": 1,
        "acknowledged": 1,
        "replicaCount": 0,
        "cachedCount": 0,
        "satisfied": true,
        "networkTooSmall": true,
        "failedAttemptCount": 0,
        "attempts": []
      }
    }
  ],
  "replication": {
    "mode": "quorum",
    "desiredCopies": 4,
    "copies": 3,
    "required": 1,
    "acknowledged": 1,
    "replicaCount": 0,
    "cachedCount": 0,
    "satisfied": true,
    "networkTooSmall": true,
    "failedAttemptCount": 0,
    "attempts": []
  }
}
```

Placement is decided per CID, so each entry of `files` carries its own report. The top-level
`replication` object repeats the first file's report for clients written against the earlier shape;
new clients should read the per-file field.

The report is counts and per-attempt outcomes only. It never carries node names, peer ids, or peer
error text.

| Status | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `200`  | Every file was stored and pinned                                              |
| `400`  | No file was sent, too many files, or one file exceeded `uploadLimitSizeBytes` |
| `413`  | The combined size exceeded `storage.maxRequestSizeBytes`                      |
| `429`  | The upload rate limit or the concurrent upload limit was exceeded             |
| `503`  | A required replication quorum could not be reached                            |
| `507`  | Storing the request would consume `storage.diskReserveBytes`                  |
| `500`  | Storage or replica settlement failed; do not treat it as a clean rejection    |

An interrupted upload leaves no blocks behind: each request owns a session that removes exactly the
blocks it created. See [the storage lifecycle](/storage-lifecycle).

## Download a file

```bash
curl --fail-with-body \
  --output file.bin \
  https://ipfs.example.org/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm
```

Responses are the complete representation, served as `application/octet-stream` with
`Content-Disposition: attachment; filename="<cid>"` and `X-Content-Type-Options: nosniff`. A
successful response carries an `ETag` holding the quoted CID,
`Cache-Control: private, max-age=3600, must-revalidate`, and `Accept-Ranges: none`. A matching
`If-None-Match` answers `304` after availability has been checked.

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `200`  | The response contains the requested file as an attachment                                  |
| `304`  | The `If-None-Match` validator matched                                                      |
| `400`  | The CID is invalid                                                                         |
| `408`  | The file could not be found or retrieved before the configured timeout                     |
| `429`  | The read rate limit, the per-client, or the global download concurrency limit was exceeded |
| `500`  | An unexpected internal failure occurred before streaming started                           |

Range headers are ignored. Discovery, idle transfer time, and the size-aware complete transfer all
have bounded deadlines and all end in `408 File request timed out`, so a failed request may spend
more than one `findFileTimeout` before answering. A client disconnect cancels the underlying
retrieval. If an error occurs after response bytes have started, the server terminates the
incomplete response, because a status and a JSON body can no longer be sent safely.

The node never answers `404` for a CID it cannot retrieve: it cannot know whether the content exists
somewhere it cannot see.

## File status

```bash
curl --fail-with-body \
  https://ipfs.example.org/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm/status
```

```json
{
  "cid": "bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm",
  "state": "confirmed",
  "pinned": true,
  "createdAt": 1720614998797,
  "expiresAt": null,
  "confirmedAt": 1720614998797,
  "replication": { "acknowledged": 1, "required": 1, "heldLocally": true }
}
```

`state` is `temporary`, `confirmed`, or `expired`. An unknown CID answers `404`. The response
carries no filename and no peer identity.

## Storage metrics and policy

```bash
curl --fail-with-body https://ipfs.example.org/api/storage/metrics
curl --fail-with-body https://ipfs.example.org/api/storage/policy
```

`metrics` reports pinned, reclaimable, available, and reserved bytes, the lifecycle counters, the
state of the background jobs, and the libp2p replication protocol this node speaks. Nodes on
different protocol versions cannot place copies on each other, so a mixed deployment is visible
here. Values refresh on `diskUsageScanPeriod`, not per request.

`policy` reports the limits and the durability mode a client should expect before uploading:
`maxFileCount`, `uploadLimitSizeBytes`, `maxRequestSizeBytes`, the concurrency limits,
`confirmationRequired`, `temporaryTtlMs`, and a `durability` object holding `mode`
(`quorum` or `best-effort`), `placement`, and `ackQuorum`.

Both routes are public and carry no filenames, CID lists, or peer identity.

## Node health

```bash
curl --fail-with-body https://ipfs.example.org/api/node/health
```

This route always returns HTTP `200`. Consumers must read `state`, which is `starting`, `ready`,
`stale`, or `degraded`.

`height` is a persisted, monotonic Unix-millisecond checkpoint at the start of a fixed round. It
advances only when startup reconciliation, storage freshness and reserve, a complete successful
repair cycle with no known backlog, and the configured peer attestations all pass, and it freezes on
failure.

State changes are asymmetric. The response is served from the last checkpoint, and reading it
recomputes only what elapsed time can decide, so a node may be downgraded to `degraded` or `stale`
between checkpoints. Returning to `ready` requires a successful checkpoint, so expect up to
`health.checkpointIntervalMs` of lag after the underlying fault clears.

`evaluatedAt` dates the last checkpoint attempt, which may have failed. `checkpoint.observedAt`
dates the last attempt that succeeded. `checks.checkpointFresh`, `checks.storageFresh`, and
`checks.repairFresh` are recomputed at read time; every other entry in `checks`, and `membership`
and `startup`, describe `evaluatedAt`.

`membership.version` identifies the configured peer-set epoch. Changing the node list resets the
persisted checkpoint for that node, so `height` stays `0` until the first valid checkpoint under the
new membership. Compare heights only between nodes reporting the same membership version, and treat
a version change as a new epoch.

A full annotated example and the alerting rules are in
[Monitoring and health](/operations/monitoring).

## Legacy node information

```bash
curl --fail-with-body https://ipfs.example.org/api/node/info
```

This public compatibility route retains `version`, `timestamp`, `heliaStatus`, `blockstoreSizeMb`,
`datastoreSizeMb`, and `availableSizeInMb` for the current PWA and iOS application. It exposes no
peer identity and no topology.

## Administrative node details

```bash
curl --fail-with-body \
  --header 'x-api-key: your-generated-key' \
  https://ipfs.example.org/api/node/details
```

The authenticated response adds `peerId`, `multiAddresses`, byte-accurate storage figures
(`pinnedBytes`, `reclaimableBytes`, `availableBytes`, `reservedBytes`), the complete `health`
object, bounded HTTP counters under `http`, and admission-limiter occupancy under `concurrency`.
Counters accumulate since process start and carry no paths, CIDs, IP addresses, or user-controlled
labels.

## Garbage collection

```bash
curl --fail-with-body --request POST \
  --header 'x-api-key: your-generated-key' \
  'https://ipfs.example.org/api/storage/gc?dryRun=true'
```

`?dryRun=true` reports the exact CIDs that would be released and retained without touching a block,
which is the supported way to review a deletion policy before enabling the scheduled collector.
`?force=true` collects even when the blockstore is below the high watermark. A run already in
progress answers `409`.

The report carries `trigger`, `blockstoreBytesBefore`, `estimatedBytesAfter`, `releasedCids`,
`retainedCids`, `demoted`, `removedBlocks`, `removedCids`, `repairedPins`, `unprotected`, and
`errors`. `demoted` lists files whose local copy was handed over to their designated holders.

## Replication repair

```bash
curl --fail-with-body --request POST \
  --header 'x-api-key: your-generated-key' \
  https://ipfs.example.org/api/storage/repair
```

Runs the next bounded repair pass and reports its progress and the cycle state. A run already in
progress answers `409`. Repair places copies of any confirmed file whose designated holders have not
all acknowledged.

## Administrative and debug routes

These are operator tools. They are not part of `docs/openapi.yaml` and may change with the runtime.

| Route                               | Purpose                            |
| ----------------------------------- | ---------------------------------- |
| `GET /api/helia/pins`               | List the pin set                   |
| `POST /api/helia/pin/:cid`          | Pin and register arbitrary content |
| `GET /api/helia/pins/isPinned/:cid` | Report whether a CID is pinned     |
| `GET /api/libp2p/status`            | Report libp2p status               |
| `GET /api/libp2p/peers`             | List connected peers               |
| `GET /api/libp2p/connections`       | List connections                   |
| `GET /api/libp2p/peerStore`         | Read peer-store data               |
| `GET /api/libp2p/peerInfo`          | Read information about one peer    |
| `GET /api/libp2p/dial`              | Dial a peer on request             |
| `GET /api/libp2p/services/ping`     | Ping a peer                        |
| `GET /api/debug/autopeering`        | Run one peering pass on request    |

`GET /api/helia/routing/findProviders/:cid` no longer exists: provider lookup needs content routing,
and this node registers none. `/api/debug/*` is not mounted at all unless `enableDebugApi` is
`true`, and it still requires the key.

## Error format

Errors are JSON objects with a single `error` string. `x-powered-by` is disabled, and an unmatched
path answers `404` from the not-found handler.

## Machine-readable specification

The OpenAPI 3.1 document is published at [`openapi.yaml`](/openapi.yaml) and lives in the repository
at `docs/openapi.yaml`.

Neither the node nor this site serves an interactive API explorer. There is no `/swagger` endpoint
and no Swagger UI; use the specification file with a client generator or an editor of your choice.
