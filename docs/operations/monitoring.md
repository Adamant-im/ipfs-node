---
title: Monitoring and health
description: Health states, checkpoint semantics, storage metrics, HTTP counters, and what to alert on when running the node.
---

# Monitoring and health

The node exposes a readiness contract, a storage report, and structured logs. This page describes
what each one means and which signals are worth an alert.

## What to monitor

| Signal            | Source                                             | Why                                                        |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Node state        | `GET /api/node/health`                             | Whether the node should receive traffic                    |
| Checkpoint age    | `GET /api/node/health`                             | Whether the readiness evidence is current                  |
| Disk reserve      | `GET /api/node/health`, `GET /api/storage/metrics` | Uploads are refused with `507` once the reserve is at risk |
| Repair backlog    | `GET /api/node/health`                             | Durability shortfalls that have not been repaired          |
| Limiter occupancy | `GET /api/node/details`                            | Distinguishes a capacity `429` from a rate-limit `429`     |
| HTTP counters     | `GET /api/node/details`                            | Error rates and aborted responses                          |
| Logs              | stdout                                             | Startup warnings, job failures, protocol errors            |

## Health states

`GET /api/node/health` always answers HTTP `200`. A monitor that only checks the status code will
call a broken node healthy.

| State      | Meaning                                                                    | What to do                                         |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| `starting` | Startup reconciliation has not finished                                    | Wait; alert only if it persists far past startup   |
| `ready`    | Every prerequisite passed in the last checkpoint                           | Serve traffic                                      |
| `degraded` | A prerequisite currently fails, but the last checkpoint is not yet expired | Investigate `checks`; the node still answers reads |
| `stale`    | The last checkpoint is older than `health.maxCheckpointAgeMs`              | Treat the node's readiness evidence as unusable    |

Recovery is never decided on a read. A node returns to `ready` only after a successful checkpoint,
so expect up to `health.checkpointIntervalMs` of lag once the underlying fault clears.

## Reading a health response

```json
{
  "version": "0.1.0",
  "uptimeMs": 123456,
  "state": "ready",
  "height": 1720614960000,
  "timestamp": 1720614998797,
  "evaluatedAt": 1720614998700,
  "checkpoint": {
    "intervalMs": 60000,
    "observedAt": 1720614998700,
    "ageMs": 97,
    "maxAgeMs": 180000
  },
  "membership": {
    "version": "d0f1...",
    "requiredPeers": 1,
    "attestedPeers": 2
  },
  "startup": { "complete": true, "healthy": true },
  "storage": {
    "measuredAt": 1720614980000,
    "measurementAgeMs": 18797,
    "reserveHealthy": true
  },
  "replication": {
    "repairRequired": true,
    "schedule": "0 */30 * * * *",
    "lastCompleteAt": 1720614900000,
    "ageMs": 98797,
    "backlog": 0,
    "consecutiveUnsuccessfulCycles": 0,
    "lastCycle": {
      "examined": 1400,
      "stillMissing": 0,
      "unrecoverable": 0,
      "completedAt": 1720614900000,
      "successful": true
    }
  },
  "checks": {
    "checkpointFresh": true,
    "clockConsistent": true,
    "helia": true,
    "startupReconciliation": true,
    "storageFresh": true,
    "storageReserve": true,
    "repairFresh": true,
    "peerAttestations": true
  }
}
```

Field by field:

- `height` is a persisted, monotonic Unix-millisecond checkpoint at the start of a fixed round. It
  advances only when every prerequisite passes and freezes on failure
- `timestamp` is when this response was produced; `evaluatedAt` is when the checkpoint attempt
  behind it ran, which may have been a failed attempt
- `checkpoint.observedAt` dates the last attempt that succeeded, so it differs from `evaluatedAt`
  whenever the most recent attempt failed
- `membership.version` is a 64-character digest of the configured peer set
- `replication.consecutiveUnsuccessfulCycles` counts complete repair sweeps in a row that ended with
  backlog or unrecoverable records; it resets to `0` on any complete clean cycle
- `replication.schedule` exposes the configured repair cron expression so monitors know the cycle interval
- `replication.lastCycle` summarizes candidate counts and outcome of the last completed repair sweep

The `checks` object splits into two kinds. `checkpointFresh`, `storageFresh`, and `repairFresh` are
recomputed at read time, because elapsed time alone can invalidate them. Every other check, along
with `membership` and `startup`, describes `evaluatedAt`.

`repairFresh` is automatically true when repair is not required — that is, when
`replication.enabled` or `replication.repairEnabled` is false. When repair is required, the check
demands a completed cycle within `health.repairMaxAgeMs` and zero backlog, unless
`health.repairBacklogGraceCycles` allows consecutive complete unsuccessful cycles with backlog. A cycle
that never completes still fails `repairFresh` through `health.repairMaxAgeMs`. Immediate prerequisites
(Helia, disk reserve, clock consistency, startup, and peer attestations) remain immediate and are
never delayed by grace cycles.

A clock that moves behind the checkpoint this node already recorded clears `clockConsistent` and
stops advancement until it catches up, rather than persisting a round that starts after it finished.

## Alerting rules

Express thresholds in terms of the configured values, not in absolute seconds.

Split monitoring into immediate prerequisites and repair durability:

- **Immediate alerts**:
  - `checks.helia` is false: the libp2p/Helia subsystem is down
  - `checks.storageReserve` is false: free space has fallen into `storage.diskReserveBytes`, and uploads answer `507`
  - `checks.clockConsistent` is false: the host clock moved backwards
  - `checks.startupReconciliation` is false: startup validation failed
  - `checks.peerAttestations` is false: `membership.attestedPeers` is below `membership.requiredPeers`
  - `checkpoint.ageMs` exceeds `checkpoint.maxAgeMs`, which is the definition of `stale`
- **Repair durability alerts**:
  - `checks.repairFresh` is false (with default `repairBacklogGraceCycles: 0`, any non-zero backlog or unhealthy cycle fails freshness immediately; with grace configured, `replication.consecutiveUnsuccessfulCycles > health.repairBacklogGraceCycles`)
  - `replication.ageMs` approaches `health.repairMaxAgeMs`, which means a cycle is not completing inside its window
- `membership.version` changed without a configuration change being deployed
- `height` frozen while `state` is `ready` on other nodes of the same membership version

Compare `height` only between nodes reporting the same `membership.version`. Peers may attest an
adjacent round across a boundary, so two healthy nodes can briefly report heights one
`checkpointIntervalMs` apart; that is normal and not an alert.

## Storage metrics

`GET /api/storage/metrics` is public and reports:

- `pinnedBytes` — content protected by a pin, estimated from the full DAG of each registered file
- `reclaimableBytes` — blockstore bytes that no pin protects
- `availableBytes` — free space on the blockstore filesystem
- `reservedBytes` and `usableBytes` — the disk reserve and what is left for uploads
- `files` — how many files are in each lifecycle state
- `stagedReplicas` — registry entries still belonging to an in-flight strict upload
- the garbage collection and replication job state, including the last run and its errors
- `replication.protocol` — the libp2p protocol version this node offers

Values refresh on the `diskUsageScanPeriod` schedule, because a directory scan and a full registry
sweep are too expensive for a request path. A metric that looks stale is usually as fresh as that
schedule allows.

Watch `gc.lastRun.errors` after each collection.

## HTTP and concurrency counters

`GET /api/node/details` adds two objects behind the administrative key.

`http` holds counters accumulated since process start — not a sliding window: `requests`, the
`responses` split by status family, `aborted` (responses whose connection closed before the body
finished, counted apart from the status families), `inFlight`, and response-time totals. Compute
rates by differencing successive samples.

`concurrency` holds admission-limiter occupancy for uploads, incoming copies, and downloads, each
with `active` and `limit`, plus the per-client download limit. A rate-limit refusal and an admission
refusal are both `429` and need opposite reactions — one means a client is asking too often, the
other means the node has run out of slots — so this is the field that tells them apart.

## Logs

Logs are newline-delimited JSON from Pino on stdout. `logLevel` accepts `fatal`, `error`, `warn`,
`info`, `debug`, `trace`, and `silent`. Keep `prettyLogs: false` outside an interactive terminal so
a collector keeps the structured fields.

Records carry no user content. Request logs record the method, a masked route shape, and the status
code; `x-api-key`, `authorization`, and `cookie` are redacted; and application messages pass a
scrubber that replaces content identifiers, peer ids, multiaddrs, and stack traces with fixed
placeholders.

Two warnings are expected on a fresh installation and are not faults: the TLS notice at listen time,
and the `trustProxy is false` notice. Do not widen the proxy trust rule merely to silence the
second; see [Security and privacy](/guide/security).

## Staged rollouts and membership epochs

During a staged deployment older peers do not implement the health protocol. Set
`health.requiredPeerCount` to `0` on the transitioning fleet, then raise it once every required peer
is upgraded; otherwise prolonged `degraded` health is the expected fail-safe result.

While it is `0`, `checks.peerAttestations` is always true and the checkpoint proves only this node's
own prerequisites. Network coverage is not validated in that window, so treat routing decisions that
depend on it as unverified.

Changing `nodes` changes the membership epoch and resets the persisted checkpoint, so `height`
returns to `0` on every node for the new epoch. Plan for that when a monitor alerts on height
regressions. The upgrade sequence is in [Upgrades and rollback](/operations/upgrades).
