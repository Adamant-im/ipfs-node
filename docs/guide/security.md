---
title: Security
description: Trust boundaries, HTTP access classes, TLS and proxy expectations, the administrative key, CORS, limits, and what the peer topology does not protect.
---

# Security

This page describes the security boundaries the node enforces itself, the boundaries it expects a
deployment to enforce around it, and the privacy properties of the controlled peer topology.
Everything here is current behaviour of the code. Option names and defaults are described in
[Configuration](/guide/configuration); the composition of the libp2p host is described in
[Architecture](/guide/architecture).

## Threat model

Assets worth protecting in a deployment:

- the blockstore and datastore under `$HOME/<storeFolder>`, which hold content blocks, the pin set,
  and the file lifecycle registry
- the libp2p private key, stored in the datastore at `/pkcs8/self`, which is the node's peer
  identity
- the administrative API key in the configuration file
- free disk space on the filesystem that holds the blockstore

Components the node assumes are trusted:

- the host filesystem and the operating-system account the process runs as
- the reverse proxy in front of the HTTP port, when one is deployed
- the peers listed in `nodes`, which may place durable copies on this node and attest its health

Components the node treats as untrusted:

- every HTTP client, including uploaders
- every libp2p peer that is not listed in `nodes`
- the bytes of every uploaded file

Within that model the node defends against unauthenticated use of administrative routes, unbounded
disk consumption, request floods from a single address, forged forwarding headers once trusted proxy
addresses are configured, internal detail leaking into HTTP error responses, and content identifiers
leaking into logs. It does not defend against the cases listed under
[what this does not protect against](#what-this-does-not-protect-against).

## HTTP access policy

Routers are mounted in classes by `src/security/accessPolicy.ts`. Administrative classes receive the
API-key middleware at mount time, so a route cannot be added to an administrative router and reach
the network unauthenticated.

| Class                | Routes                                                                                                                                                                           | Policy                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Public               | `GET /`, `GET /api/node/health`, `GET /api/node/info`                                                                                                                            | No authentication                                       |
| Public file transfer | `POST /api/file/upload`, `GET /api/file/:cid`                                                                                                                                    | No authentication; rate and upload limits apply         |
| Public storage state | `GET /api/file/:cid/status`, `GET /api/storage/metrics`, `GET /api/storage/policy`                                                                                               | No authentication                                       |
| Administrative       | `GET /api/node/details`, `POST /api/file/:cid/confirm`, `POST /api/file/:cid/unpin`, `POST /api/storage/gc`, `POST /api/storage/repair`, all `/api/helia/*`, all `/api/libp2p/*` | `x-api-key` required                                    |
| Disabled by default  | `GET /api/debug/autopeering`                                                                                                                                                     | Only when `enableDebugApi` is true; still needs the key |
| Peer protocols       | libp2p, not HTTP                                                                                                                                                                 | Handshake-authenticated                                 |

Two properties hold across every class:

- a path outside the documented surface returns `404` with the body `{"error":"Not found"}`
- thrown values pass through one error handler that maps them to a fixed set of statuses and
  messages. The complete error is logged server-side; stack traces, filesystem paths, and dependency
  messages are never returned to a client.

`x-powered-by` is disabled, so the response set carries no framework banner. The full request and
response contract is in the [API reference](/reference/api) and the generated
[endpoint reference](/reference/endpoints).

## TLS boundary

The process serves plain HTTP. There is no TLS listener, no certificate handling, and no HTTPS
redirect at the application level. `app.listen(serverPort)` is called without a host, so the HTTP
port is bound on every interface of the machine. At startup the node logs a warning saying that TLS
is not handled at the application level and that the service belongs behind a TLS-terminating
reverse proxy.

A deployment has to close that boundary itself:

- restrict `serverPort` to a private interface or a firewall rule so that only the reverse proxy can
  reach it
- terminate TLS at the proxy and forward plain HTTP to the node over a trusted network path
- have the proxy replace client-supplied forwarding headers rather than append to them. `X-Forwarded-For`,
  `X-Forwarded-Proto`, and `X-Forwarded-Host` arriving from the internet must not survive into the
  request the node sees.
- keep the libp2p listener out of the HTTP proxy. `peerDiscovery.listen` (template
  `/ip4/0.0.0.0/tcp/4001`) carries Noise-encrypted libp2p streams, not HTTP, and must be reachable
  by peers directly.

The container image reflects the same split: it exposes `4000` for the HTTP API and `4001` for the
libp2p listener, and ships no TLS material. See [Docker](/guide/docker).

## Reverse proxy and client identity

`trustProxy` is passed to `app.set('trust proxy', ...)` after validation in
`src/security/trustProxy.ts`.

| Value            | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `false`          | Default. No forwarding header is trusted; `req.ip` is the socket address |
| Positive integer | Number of trusted proxy hops in front of the node                        |
| String           | One exact address or CIDR range                                          |
| Array of strings | Several exact addresses or CIDR ranges                                   |

Startup aborts on `true`, on `*`, `0.0.0.0/0`, or `::/0`, on comma-separated values, on strings with
surrounding whitespace, on a hop count below `1`, and on an empty array. The blanket `true` is
rejected because it makes the last value of `X-Forwarded-For` authoritative for any client that
sends one.

Client identity matters because `req.ip` is the key for every rate limiter and for the per-client
download concurrency limit:

- with `trustProxy: false` behind a proxy, every client shares the proxy address, so one client's
  traffic is counted against all of them
- with a setting that is wider than the actual proxy chain, a client can forge a forwarding header
  and reset its own counters

The node logs a warning at startup whenever `trustProxy` is `false`, stating that all clients will
share the proxy address for rate limiting until exact trusted proxy addresses are configured. The
warning is expected when clients connect directly, and is a defect to fix when they do not.

The rule is the same on every environment. A public production node and a test network that both
terminate TLS at nginx and forward to this process need the same `trustProxy` value. Nothing about
the name of the network changes how Express reads `X-Forwarded-For`. Direct access to the process
port, with no forwarding headers, keeps `false`.

One proxy hop that overwrites `X-Forwarded-For`, on every path, is hop count `1`. That fits host
nginx in front of a container and nginx on the same machine as a
[PM2 or systemd](/guide/installation) process. Use a hop count only for a fixed topology where every
path crosses exactly that many trusted proxies.

An address list trusts the socket instead of counting hops. `['127.0.0.1/8', '::1/128']` is that
list when the proxy connection arrives from loopback, which is nginx beside a PM2 or systemd
process. It is not the address a container sees. Publishing the host port on `127.0.0.1` still
presents the bridge gateway as the socket inside the container, so that list puts every forwarded
client in one bucket. For the container, use hop count `1` or the gateway address the process
observes. The nginx snippet is in [Installation](/guide/installation), and the container publish is
in [Docker](/guide/docker).

## Administrative API key

Generate a key with:

```bash
openssl rand -hex 32
```

Validation in `src/security/config.ts` accepts an empty value or a string of at least 32 characters
that is not one of the placeholders shipped in documentation and templates
(`change-me-use-openssl-rand-hex-32`, `replace-with-output-of-openssl-rand-hex-32`,
`your-generated-key-here`). Anything else aborts startup with a message naming the field.

The middleware fails closed. While `adminApiKey` is empty, the administrative routes stay mounted
and answer `503` with `{"error":"Service not configured"}`, so an unset key cannot silently leave
them open. With a key configured, a request must carry it in the `x-api-key` header:

```bash
curl -sS -H "x-api-key: $ADM_IPFS_ADMIN_KEY" http://127.0.0.1:4000/api/node/details
```

A missing header, a non-string header, or a mismatch returns `401` with `{"error":"Unauthorized"}`.
The comparison runs `timingSafeEqual` over HMAC-SHA-256 digests keyed with the configured value, so
neither the length of the key nor a matching prefix is observable from response timing. A successful
check sets `Cache-Control: no-store` on the response.

Operational notes:

- the key is read only from the request header. Do not place it in a URL, a query string, or
  browser-side code.
- request logs redact `x-api-key`, `authorization`, and `cookie`
- the value is read at startup, so rotating it means editing the configuration file and restarting
  the process
- `enableDebugApi` is a second, independent switch. `/api/debug/*` is not mounted at all unless it is
  `true`, and it still requires the key when it is.

## CORS

`cors.allowedOrigins` is required and must be a non-empty array. Each entry is one of:

- a canonical HTTP or HTTPS origin, such as `https://adm.im` or `http://localhost:8080`
- an any-depth subdomain wildcard of the form `https://*.adamant.im`
- an exact desktop origin, `app://.` or `app://<host>`
- the opaque browser origin, configured as the literal string `null` (see below)
- a Tor hidden-service wildcard `http://*.onion` (suffix label `onion`; v3 hostname shape only)

Startup rejects a bare `*`, an entry carrying a path, credentials, query string, or fragment, a
scheme other than `http`, `https`, or exact `app`, an entry longer than 255 characters, a wildcard
hostname without a dot or longer than 253 characters, a port above 65535, and any wildcard, port, or
userinfo on an `app` entry. `file:`, `data:`, and `blob:` are rejected.

Matching for the rule `https://*.adamant.im`:

| Origin                        | Result                                            |
| ----------------------------- | ------------------------------------------------- |
| `https://msg.adamant.im`      | Allowed                                           |
| `https://a.b.adamant.im`      | Allowed; the wildcard matches any depth           |
| `https://adamant.im`          | Not allowed; the suffix origin itself is excluded |
| `http://msg.adamant.im`       | Not allowed; the scheme differs                   |
| `https://msg.adamant.im:8443` | Not allowed; the port differs                     |
| `https://notadamant.im`       | Not allowed; the match requires the dot boundary  |

An exact entry matches that origin and nothing else. A request that carries no `Origin` header is
allowed through: those are non-browser clients such as `curl`, server-to-server calls, monitoring
probes, and mobile applications, which the browser origin model never governed. A probe can therefore
be green while a browser or desktop renderer shows the node offline; see
[Troubleshooting](/operations/troubleshooting).

### Desktop `app://` origins

Electron, and similar custom-scheme desktops, load the UI outside `http` and `https`. Chromium then
sends that scheme in `Origin`. For a privileged standard scheme named `app` whose pages are loaded
as `app://./index.html`, the serialized origin is `app://.`. A build that loads
`app://localhost/…` or `app://<name>/…` sends that host instead. Configure the exact value the
client sends. There is no `app://*` wildcard.

The official ADAMANT desktop build sends `app://.`. That entry is commented out in
`config.default.json5` and in `docker/config.example.json5`. Add it only on a node that should
answer that client. [ADAMANT Messenger](/guide/adamant-messenger) is one adopter's origin set, not
the list every deployment should copy. A PWA on `https://msg.adamant.im` is covered by
`https://*.adamant.im` and does not need the desktop entry.

`app://` is not a web origin a page on `https://` can choose. Browsers set `Origin` from the
document that made the request, so allowing `app://.` does not let an arbitrary website read the
API. It does let any local application that registered the `app` scheme. That is why the entry is
an explicit opt-in rather than a default.

### Opaque `null` origin

Some browsers, including Tor Browser on certain cross-`.onion` fetches, send the header
`Origin: null`. The configuration entry is the literal four-character string `null`, not JSON
null. Enabling it tells the CORS middleware to respond with `Access-Control-Allow-Origin: *` for
those requests (not the literal header value `null`). Tor Browser cross-`.onion` fetches often
send `Origin: null` while the document origin is an onion URL; reflecting `null` fails the browser
CORS check in that case. With `credentials: false`, `*` is valid. Redirect and other flows that
keep `Origin: null` while a normal origin appears only in `Referer` must not rewrite the request
origin server-side; the browser compares ACAO to the request origin, not to `Referer`.

**This permission is not limited to Tor.** Any opaque browser origin serializes as `null`. That
includes `data:` documents, some `file:` documents, and a cross-origin
`<iframe sandbox="allow-scripts">` embedded by an arbitrary clearnet site. The allowlist cannot
distinguish a Tor messenger tab from such a frame: if the API is reachable from the user's browser,
code running in the frame can read responses the same way. Rejecting literal `data:` or `file:`
entries in `cors.allowedOrigins` does not block those documents once `null` is allowed. See
[MDN: `Access-Control-Allow-Origin: null`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin#null).

Keep `null` commented out in defaults and add it only on meshes that accept this trade-off. CORS
still does not authenticate callers; administrative routes still require the API key, and rate
limits still apply independently of whether `null` is allowed.

The rest of the CORS configuration is fixed: methods `GET` and `POST`, allowed request headers
`content-type` and `x-api-key`, `credentials: false`, and a preflight `maxAge` of 600 seconds.

CORS is never authentication. It tells a browser which pages may read a response; it stops no other
client, and it protects no route. Because `credentials: false` prevents a browser from attaching
cookies, a page can only reach an administrative route if the page itself holds the key, which is
one more reason to keep the key out of browsers.

## Rate and concurrency limits

Two independent mechanisms bound HTTP load, and both answer `429`.

Rate limiters count requests per client address in a fixed window, using `express-rate-limit` with
`draft-8` standard headers and legacy headers disabled. A window refusal is `429` with
`{"error":"Too many requests. Please try again later.","code":"rate_limited"}`, a `Retry-After`
header set to the seconds remaining in the window, and `RateLimit` / `RateLimit-Policy` headers.
The limiter writes those rate-window headers on every request it handles, including one it allows
through. Upload and download routes run it before admission, so a later admission `429` can still
carry them. Identify the refusal by `code`.

| Limiter | Option              | Default          | Routes                                                                                                                                                                                     |
| ------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload  | `rateLimits.upload` | 10 per 900000 ms | `POST /api/file/upload`                                                                                                                                                                    |
| Pin     | `rateLimits.pin`    | 10 per 900000 ms | `POST /api/helia/pin/:cid`                                                                                                                                                                 |
| Read    | `rateLimits.read`   | 100 per 60000 ms | `GET /api/file/:cid`, `GET /api/file/:cid/status`, `GET /api/node/info`, `GET /api/storage/metrics`, `GET /api/storage/policy`, `GET /api/helia/pins`, `GET /api/helia/pins/isPinned/:cid` |

`GET /api/node/health` deliberately carries no rate limiter, so a load balancer or container probe
cannot exhaust one.

Limiter state is in memory in one process. It is cleared by a restart, and a second process or a
second host keeps its own counters, so the configured limit is per process and not per deployment. A
deployment that runs more than one process, or that fronts the node with a proxy, has to enforce
rates at the proxy as well.

Admission limiters are a different mechanism: they bound how many operations may be in flight at
once, not how often they may be requested.

| Limiter                     | Option                                                       | Default | Refusal                                                       |
| --------------------------- | ------------------------------------------------------------ | ------- | ------------------------------------------------------------- |
| Uploads                     | `storage.maxConcurrentUploads`                               | 32      | `429`, `Retry-After: 5`, `code` `upload_concurrency`          |
| Downloads, global           | `storage.maxConcurrentDownloads`                             | 64      | `429`, `Retry-After: 5`, `code` `download_concurrency`        |
| Downloads, per client       | `storage.maxConcurrentDownloadsPerClient`                    | 8       | `429`, `Retry-After: 5`, `code` `download_client_concurrency` |
| Incoming copies over libp2p | Derived as `max(4, floor(storage.maxConcurrentUploads / 4))` | 8       | Protocol refusal with code `no_room`                          |

The per-client download share exists because a download slot is held for the whole transfer: without
it, one address can hold every global slot and leave the rest of the network with `429` until those
transfers end. Incoming copies get a limiter of their own because they arrive over libp2p, where the
HTTP rate limiters do not apply, and because a copy claims the aggregate request limit for its whole
duration.

Since a rate refusal and an admission refusal are both `429`, the status alone cannot tell an
operator which one fired, and the two need opposite reactions. The JSON `code` tells them apart
without reading the message text. `GET /api/node/details` also reports limiter occupancy under
`concurrency`: active count and limit for uploads, incoming copies, and downloads. See
[Monitoring](/operations/monitoring).

## Public upload decision

`POST /api/file/upload` is unauthenticated on purpose, for compatibility with clients that upload
directly to the node. The decision is bounded rather than open-ended:

- `uploadLimitSizeBytes` caps one file and `maxFileCount` caps the number of files in a request; both
  are enforced by the streaming multipart parser, so an over-limit part never reaches the blockstore
- `storage.maxRequestSizeBytes` caps the combined size of one request and is checked from
  `Content-Length` before the parser runs, answering `413` with `code` `request_too_large`
- the multipart body accepts `files` parts only; any text field is rejected with `400` and `code`
  `multipart_fields`. A missing file part is `400` with `code` `no_file`
- the upload rate limiter and the upload admission limiter apply, answering `429` with `code`
  `rate_limited` or `upload_concurrency`
- `storage.diskReserveBytes` is claimed before any block is written, so a request that would consume
  the reserve is refused with `507` and `code` `insufficient_storage`
- `storage.confirmationRequired` keeps an upload temporary until an authenticated confirmation, and
  `replication.requireQuorumOnUpload` refuses an upload with `503` and `code` `replication_quorum`
  when the required copies were not acknowledged

Those limits bound what an uploader can consume. They are not an authorization guarantee: anyone who
can reach the port can store bytes on the node. A deployment that needs signed upload authorization
must enforce it at a trusted gateway in front of the node. Uploader-signed deletion, and the
authorization protocol it depends on, are open work in [issue #27](https://github.com/Adamant-im/ipfs-node/issues/27) and are not implemented; see the
[issue tracker](https://github.com/Adamant-im/ipfs-node/issues).

On the serving side, a download is sent as `application/octet-stream` with
`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so a browser does not render
an uploaded file as a document in the node's origin. Range requests are not served and responses
carry `Accept-Ranges: none`. Lifecycle states and reclamation are described in
[the storage lifecycle](/storage-lifecycle).

## Privacy properties

The controlled topology keeps three things off the public network:

- no CID is disclosed to a public gateway. There is no gateway integration, no `/ipfs/` path routing,
  and no HTTP gateway block routing.
- no DHT provider records are published. No kad-DHT service is registered, so the node neither
  announces content nor resolves provider records.
- block requests stay inside the configured peer set. Bitswap exchanges blocks with connected peers,
  and the node dials only the multiaddrs in `nodes` and `peerDiscovery.bootstrap`.

That is the whole of the benefit. It does not make a deployment private, anonymous, trustless, or
censorship-proof. Content is not confidential to the operator, the peers listed in `nodes` observe
the CIDs this node asks them for, and anyone who learns a CID and can reach the HTTP port can fetch
the file.

Content handling:

- the node stores whatever bytes it is given and does not encrypt content. Blocks on disk are
  readable by anything with filesystem access, so an application that needs confidentiality has to
  encrypt before upload and manage its own keys.
- access time is deliberately not recorded. Replication placement tiers on file age
  (`replication.placement`), because recording when a file was last read would build a trail of user
  activity, and sharing that trail between nodes would spread it further.

Response surface:

- public responses carry counts rather than peer identity. `GET /api/file/:cid/status` reports how
  many holders acknowledged a file and whether this node still holds it, not which peers do, and it
  omits the original filename.
- `GET /api/storage/metrics` reports capacity, watermarks, and background job state, with no
  filenames, no CID lists, and no peer identity
- `GET /api/node/info` carries no node identity. Peer id, listen multiaddrs, byte-accurate storage
  figures, HTTP counters, and limiter occupancy are on the authenticated `GET /api/node/details`.

Logging:

- request logs record the method, the route shape, and the status code only. A variable path segment
  is masked, so `/api/file/<cid>/status` is logged as `/api/file/:param/status`.
- application messages pass a scrubber that replaces content identifiers, peer ids, multiaddrs, and
  stack traces with fixed placeholders before a record is written
- an upload logs how many files arrived, never their names
- `x-api-key`, `authorization`, and `cookie` are redacted in request and response logs

## What this does not protect against

- A compromised host. The blockstore, the datastore, the libp2p private key at `/pkcs8/self`, and the
  configuration file holding the administrative key are ordinary files readable by the account that
  runs the process.
- Anyone who learns a CID. Retrieval is unauthenticated, so the CID is the only thing a download
  needs.
- The operator of any node listed in `nodes`. A configured peer is trusted to hold durable copies, to
  answer for content, and to attest health.
- A peer that is not listed in `nodes` but can reach the libp2p listener. There is no connection
  gater, so such a peer can connect, exchange blocks over Bitswap for content this node already
  holds, and request a cache copy, which is bounded by intake room rather than by authorization.
  Durable replication operations and health attestations are refused. Firewall the libp2p port to the
  peer set when that distinction is not enough.
- Content abuse. Uploads are unauthenticated and there is no scanning, classification, or takedown
  workflow; removal today is an operator action through the authenticated
  `POST /api/file/:cid/unpin`.
- Distributed denial of service. Limiters are per process and in memory, so absorbing a flood from
  many addresses needs a proxy or a network layer in front of the node.
- Traffic accounting and volume quotas. Per-client bandwidth accounting and monthly limits are open
  work in [issue #29](https://github.com/Adamant-im/ipfs-node/issues/29) and are not implemented.
- Availability. Replication settings bound durability, not uptime: availability still depends on
  independent nodes, independent operators, and deployment choices.

## Dependency and static analysis

| Command                       | What it does                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run security:audit`      | Runs `npm audit --omit=dev --omit=peer --json` and fails, naming the packages, when any advisory has `high` or `critical` severity           |
| `npm run security:audit:raw`  | The same scope through plain `npm audit` with `--audit-level=high`, for reading the report directly                                          |
| `npm run security:audit:full` | Writes the full JSON report for that scope to `npm-audit-report.json`                                                                        |
| `npm run security:semgrep`    | Runs Semgrep over `src/` with `p/owasp-top-ten`, `p/nodejs`, `p/expressjs`, `p/typescript`, and the repository rules in `.semgrep/rules.yml` |

The policy is that a `high` or `critical` advisory in the production dependency tree fails the check.
Development and peer dependencies are outside that scope on purpose: the container build runs
`npm prune --omit=dev --omit=peer`, so the audited tree is the tree that runs.

Two practical notes:

- Semgrep is not an npm dependency of this repository. The script calls the `semgrep` CLI, which has
  to be installed separately.
- an install for auditing only may use `--ignore-scripts`, but the resulting tree cannot start the
  node, because a native dependency of the WebRTC transport package needs its install script. Use a
  normal `npm ci` for anything that has to run. npm 12 also needs that package named in
  `package.json` `allowScripts`; this repository already lists it, and `.npmrc`
  `strict-allow-scripts=true` fails the install if a new unreviewed script appears

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub security advisories on
[the repository](https://github.com/Adamant-im/ipfs-node) rather than by opening a public issue.

A useful report states the affected version or commit, the configuration needed to reproduce the
problem, the request or peer interaction that triggers it, and the impact observed. Everything that
is not a vulnerability belongs in the
[issue tracker](https://github.com/Adamant-im/ipfs-node/issues).
