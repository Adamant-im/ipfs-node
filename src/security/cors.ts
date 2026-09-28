import type { CorsOptions } from 'cors'

type OriginRule = {
  protocol: string
  hostname: string
  port: string
  wildcard: boolean
}

/**
 * Exact `app://` origins. The dot host is what Chromium serializes for a
 * standard Electron scheme loaded as `app://./…` (`Origin: app://.`).
 * A normal host covers builds that load `app://localhost/…` or `app://<name>/…`.
 * No wildcard, port, userinfo, path, query, or fragment: each entry is one origin.
 */
const APP_ORIGIN =
  /^app:\/\/(?:\.|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/

/** v3 onion service names: optional subdomain labels, then a 56-character base32 label. */
const ONION_V3_ORIGIN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z2-7]{56}\.onion$/

/**
 * Compile a list of exact origins and any-depth subdomain suffix wildcards.
 * HTTP(S) wildcards use the form `https://*.example.org`; paths, credentials,
 * query strings, fragments, and the suffix origin itself are rejected.
 * Desktop clients opt in with an exact `app://.` or `app://<host>` entry.
 * Tor hidden services use `http://*.onion` (suffix `onion` is the only wildcard label without an
 * interior dot). Matching requires a v3 onion hostname shape, not merely any string ending in
 * `.onion`.
 * Tor Browser may send `Origin: null` for cross-`.onion` fetches; opt in with the exact entry
 * `null` (the four-character string, not JSON null).
 * `file:`, `data:`, `blob:`, and a bare `*` stay rejected.
 *
 * @param allowedOrigins browser origins accepted by the API
 * @returns a predicate suitable for testing a request Origin value
 */
export function createOriginMatcher(allowedOrigins: unknown): (origin: string) => boolean {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error('cors.allowedOrigins must be a non-empty array')
  }

  const rules = allowedOrigins.map(parseOriginRule)

  return (origin: string): boolean => {
    if (origin === 'null') {
      return rules.some((rule) => rule.protocol === 'null:')
    }

    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return false
    }

    // `new URL('app://.')` has an empty path, not `/`, and an opaque origin.
    // Only that canonical form matches a configured app rule.
    if (parsed.protocol === 'app:') {
      if (parsed.pathname !== '' || parsed.port !== '') {
        return false
      }

      return rules.some(
        (rule) => rule.protocol === 'app:' && !rule.wildcard && parsed.hostname === rule.hostname
      )
    }

    if (parsed.pathname !== '/') {
      return false
    }

    return rules.some((rule) => {
      if (parsed.protocol !== rule.protocol || parsed.port !== rule.port) {
        return false
      }

      if (!rule.wildcard) {
        return parsed.hostname === rule.hostname
      }

      if (rule.hostname === 'onion') {
        return matchesOnionV3OriginHost(parsed.hostname)
      }

      return parsed.hostname !== rule.hostname && parsed.hostname.endsWith(`.${rule.hostname}`)
    })
  }
}

/**
 * Create the callback used by the Express CORS middleware. Requests without an
 * Origin header are non-browser requests and are allowed.
 *
 * @param allowedOrigins browser origins accepted by the API
 * @returns a CORS origin callback
 */
export function createCorsOriginDelegate(allowedOrigins: unknown): CorsOptions['origin'] {
  const matchesOrigin = createOriginMatcher(allowedOrigins)

  return (origin, callback): void => {
    if (origin === undefined) {
      callback(null, true)
      return
    }

    if (origin === 'null') {
      // Opt-in only via the literal `null` entry. Tor cross-`.onion` fetches often
      // send this header while the document origin is an onion URL; reflecting
      // `Access-Control-Allow-Origin: null` fails the browser CORS check in that
      // case. Public routes use `credentials: false`, so `*` is valid when opted in.
      callback(null, matchesOrigin('null') ? '*' : false)
      return
    }

    callback(null, matchesOrigin(origin) ? origin : false)
  }
}

function parseOriginRule(value: unknown): OriginRule {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new Error('Each CORS origin must be a non-empty string of at most 255 characters')
  }

  if (value === 'null') {
    return {
      protocol: 'null:',
      hostname: '',
      port: '',
      wildcard: false
    }
  }

  if (/^app:/i.test(value)) {
    return parseAppOrigin(value)
  }

  const wildcardMatch = /^(https?):\/\/\*\.([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value)
  if (wildcardMatch) {
    const [, protocol, hostname, port = ''] = wildcardMatch
    validateWildcardSuffix(hostname)
    validatePort(port)
    return {
      protocol: `${protocol.toLowerCase()}:`,
      hostname: hostname.toLowerCase(),
      port,
      wildcard: true
    }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`)
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes('*') ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(`CORS entries must be canonical HTTP(S) origins: ${value}`)
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    wildcard: false
  }
}

/**
 * Accept one exact desktop origin. The configured string must already be the
 * canonical serialization Chromium puts in `Origin`, so `APP://.` and
 * `app://./` are rejected rather than silently rewritten.
 *
 * @param value candidate `app://` entry
 * @returns a non-wildcard rule
 */
function parseAppOrigin(value: string): OriginRule {
  if (!APP_ORIGIN.test(value)) {
    throw new Error(
      `CORS app origins must be canonical app://. or app://<host> values with no wildcard, port, path, or userinfo: ${value}`
    )
  }

  const parsed = new URL(value)
  if (
    parsed.href !== value ||
    parsed.protocol !== 'app:' ||
    parsed.username ||
    parsed.password ||
    parsed.port !== '' ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== ''
  ) {
    throw new Error(
      `CORS app origins must be canonical app://. or app://<host> values with no wildcard, port, path, or userinfo: ${value}`
    )
  }

  return {
    protocol: 'app:',
    hostname: parsed.hostname,
    port: '',
    wildcard: false
  }
}

function validateHostname(hostname: string): void {
  if (
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..')
  ) {
    throw new Error(`Invalid wildcard CORS hostname: ${hostname}`)
  }
}

/**
 * Wildcard suffix for `http://*.onion` uses the label `onion` alone; every other suffix still
 * needs an interior dot.
 */
function validateWildcardSuffix(hostname: string): void {
  if (hostname === 'onion') {
    return
  }

  validateHostname(hostname)
}

function matchesOnionV3OriginHost(hostname: string): boolean {
  return ONION_V3_ORIGIN_HOST.test(hostname.toLowerCase())
}

function validatePort(port: string): void {
  if (port && Number(port) > 65535) {
    throw new Error(`Invalid CORS port: ${port}`)
  }
}
