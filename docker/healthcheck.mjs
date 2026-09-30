#!/usr/bin/env node
/**
 * Container health check for ADAMANT IPFS Node.
 *
 * `GET /api/node/health` always answers `200` and reports the node state in the
 * JSON body, so a check that only looked at the status code would call a
 * `degraded` or `stale` node healthy. This script evaluates the documented
 * readiness semantics instead.
 *
 * Environment:
 *
 * - `IPFS_NODE_HEALTHCHECK_URL` — full URL to probe.
 *   Default `http://127.0.0.1:${IPFS_NODE_HEALTHCHECK_PORT}/api/node/health`
 * - `IPFS_NODE_HEALTHCHECK_PORT` — API port when no URL is given. Default `4000`
 * - `IPFS_NODE_HEALTHCHECK_STATES` — comma-separated states treated as healthy.
 *   Default `ready`. Set `ready,degraded` only when a deployment deliberately
 *   accepts a node whose prerequisites currently fail
 * - `IPFS_NODE_HEALTHCHECK_TIMEOUT_MS` — request timeout. Default `5000`
 *
 * Exit codes follow the Docker contract: `0` healthy, `1` unhealthy.
 */

const port = process.env.IPFS_NODE_HEALTHCHECK_PORT ?? '4000'
const url = process.env.IPFS_NODE_HEALTHCHECK_URL ?? `http://127.0.0.1:${port}/api/node/health`
const timeoutMs = Number.parseInt(process.env.IPFS_NODE_HEALTHCHECK_TIMEOUT_MS ?? '5000', 10)
const healthyStates = (process.env.IPFS_NODE_HEALTHCHECK_STATES ?? 'ready')
  .split(',')
  .map((state) => state.trim())
  .filter((state) => state !== '')

/** Report the reason and exit unhealthy. */
function unhealthy(reason) {
  console.error(`unhealthy: ${reason}`)
  process.exit(1)
}

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  unhealthy('IPFS_NODE_HEALTHCHECK_TIMEOUT_MS must be a positive integer')
}

if (healthyStates.length === 0) {
  unhealthy('IPFS_NODE_HEALTHCHECK_STATES must list at least one state')
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs)

let response
try {
  response = await fetch(url, { signal: controller.signal })
} catch (err) {
  unhealthy(`${url} did not answer: ${err.message}`)
} finally {
  clearTimeout(timer)
}

if (!response.ok) {
  unhealthy(`${url} answered HTTP ${response.status}`)
}

let payload
try {
  payload = await response.json()
} catch (err) {
  unhealthy(`${url} returned a body that is not JSON: ${err.message}`)
}

const state = payload?.state
if (typeof state !== 'string') {
  unhealthy('the health response carries no state field')
}

if (!healthyStates.includes(state)) {
  const failed = Object.entries(payload.checks ?? {})
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)
  const detail = failed.length > 0 ? `; failing checks: ${failed.join(', ')}` : ''
  unhealthy(`state is "${state}", expected one of ${healthyStates.join(', ')}${detail}`)
}

console.log(`healthy: state "${state}", height ${payload.height ?? 'unknown'}`)
