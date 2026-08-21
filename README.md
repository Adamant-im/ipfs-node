# ADAMANT IPFS node

This service embeds a Helia/libp2p node and exposes the file-transfer API used by ADAMANT Messenger. It stores uploaded files in an on-disk IPFS blockstore, pins them, retrieves content by CID, and maintains connections to configured peers.

The application is not a Kubo wrapper. It is a Node.js service with an Express REST API around an in-process Helia node.

## Requirements

- Node.js 20 or later
- A TLS-terminating reverse proxy for every public deployment
- A unique administrative API key for operator endpoints

## Install and run

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
npm ci
npm run build
node dist/index.js
```

The process can also be managed with PM2:

```bash
npm install --global pm2
pm2 start dist/index.js --name="IPFS node"
```

## Configuration

Copy `config.default.json5` to `config.json5` and replace all deployment-specific values. The security-relevant fields are shown below:

```jsonc
{
  "serverPort": 4000,
  "uploadLimitSizeBytes": 268435456,
  "maxFileCount": 10,
  "cors": {
    "allowedOrigins": ["https://adm.im", "https://*.adamant.im", "http://localhost:8080"]
  },
  "trustProxy": false,
  "rateLimits": {
    "upload": { "windowMs": 900000, "limit": 10 },
    "pin": { "windowMs": 900000, "limit": 10 },
    "read": { "windowMs": 60000, "limit": 100 }
  },
  "adminApiKey": "",
  "enableDebugApi": false
}
```

Generate the administrative secret before enabling operator endpoints:

```bash
openssl rand -hex 32
```

Set the generated value as `adminApiKey`. A missing or empty key fails closed: administrative routes return `503 Service not configured`. Known placeholder values and secrets shorter than 32 characters prevent startup.

### Configuration migration

- Replace `cors.origin` or `cors.originRegexps` with `cors.allowedOrigins`
- Use exact origins such as `https://adm.im` or left-most subdomain wildcards such as `https://*.adamant.im`
- Set `adminApiKey` before using any administrative API
- Leave `trustProxy` as `false` for direct connections; configure exact proxy addresses, CIDR ranges, or a verified hop count behind a proxy
- Set `enableDebugApi: true` only when the authenticated debug route is operationally required
- Tune the endpoint-specific `rateLimits` for the deployment perimeter

Invalid CORS, proxy, API-key, or rate-limit configuration stops the process instead of silently weakening the boundary.

## HTTP access policy

| Class                | Routes                                                        | Policy                                                                    |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Public               | `GET /`, `GET /api/node/health`                               | No authentication                                                         |
| Public file transfer | `POST /api/file/upload`, `GET /api/file/:cid`                 | No authentication; endpoint-specific rate limits and upload limits apply  |
| Administrative       | `GET /api/node/info`, all `/api/helia/*`, all `/api/libp2p/*` | A matching `x-api-key` header is required                                 |
| Disabled by default  | all `/api/debug/*`                                            | Not mounted unless `enableDebugApi` is `true`; still requires `x-api-key` |
| Authenticated user   | None                                                          | The service has no end-user identity or session layer                     |

Administrative coverage includes pin operations, provider queries, dial operations, peer-store data, connection data, status, peers, and topology-sensitive node information. CORS is a browser control and is never treated as authentication.

### Public upload decision

Upload remains public for compatibility with direct Messenger clients. The service has no safe channel for distributing an upload secret and does not implement a short-lived signing protocol. Public upload is constrained by per-client request limits, per-file size, per-request file count, filename sanitization, and the deployment proxy.

This is an explicit compatibility decision, not an authorization guarantee. A deployment that requires signed upload authorization must enforce it at a trusted gateway until a client-compatible signing protocol is designed. Files of any content type are accepted, but downloads are served as `application/octet-stream` attachments with content sniffing disabled.

### CORS

`cors.allowedOrigins` accepts canonical HTTP(S) origins only. It does not accept paths, credentials, query strings, fragments, or unrestricted `*`. Wildcards are limited to a left-most subdomain. For example, `https://*.adamant.im` matches `https://chat.adamant.im` but not `https://adamant.im` or `https://adamant.im.example.org`.

Requests without an `Origin` header, such as server-to-server calls and `curl`, are not blocked by CORS. Unauthorized administrative requests are still rejected by API-key middleware.

### Trusted proxy and rate limits

Express uses the socket address as the client IP while `trustProxy` is `false`. Behind a reverse proxy, set `trustProxy` to the exact proxy address or CIDR when possible:

```jsonc
trustProxy: ['127.0.0.1/8', '::1/128']
```

A numeric hop count is supported only for a fixed topology in which every path to the application has exactly that number of trusted hops. The blanket value `true` is rejected because a client could spoof `X-Forwarded-For` when the last proxy does not overwrite it.

Application limiters use in-memory counters per process. The TLS proxy must also enforce request rates, connection limits, header limits, and a body-size limit no larger than `uploadLimitSizeBytes` for multi-process or distributed deployments.

### TLS boundary

The Node.js process serves HTTP and does not terminate TLS. Bind it to a private interface or firewall it so clients can reach it only through a correctly configured HTTPS reverse proxy. The proxy must replace untrusted forwarding headers and forward requests to the configured `serverPort`.

Never expose the application port directly to the internet.

### Dependency audit policy

Run the production policy and static checks with:

```bash
npm run security:audit
npm run security:semgrep
```

The audit fails on every unaccepted high or critical production advisory. One exact advisory, `GHSA-32mq-hpph-xfvr`, is temporarily accepted until [#21](https://github.com/Adamant-im/ipfs-node/issues/21) upgrades Helia: Helia 4 installs the affected Kademlia DHT package, but `src/helia.ts` replaces the default service map and does not instantiate the vulnerable DHT service. The audit script validates the exact package and advisory relationship so unrelated future findings still fail.

Use `npm run security:audit:raw` to inspect the unfiltered npm result.

## API usage

### Upload files

Send one or more `files` parts as multipart form data:

```bash
curl --fail-with-body \
  --form 'files=@file.txt' \
  https://ipfs.example.org/api/file/upload
```

Example response:

```json
{
  "filesNames": ["file.txt"],
  "cids": ["bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm"]
}
```

### Download a file

```bash
curl --fail-with-body \
  --output file.bin \
  https://ipfs.example.org/api/file/bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm
```

### Check public health

```bash
curl --fail-with-body https://ipfs.example.org/api/node/health
```

Example response:

```json
{
  "timestamp": 1720614998797,
  "heliaStatus": "started"
}
```

### Get administrative node information

```bash
curl --fail-with-body \
  --header 'x-api-key: your-generated-key' \
  https://ipfs.example.org/api/node/info
```

## Validation

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run lint
npm run security:audit
npm run security:semgrep
git diff --check
```
