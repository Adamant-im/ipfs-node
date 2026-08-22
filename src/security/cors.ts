import type { CorsOptions } from 'cors'

type OriginRule = {
  protocol: string
  hostname: string
  port: string
  wildcard: boolean
}

/**
 * Compile a list of exact origins and any-depth subdomain suffix wildcards.
 * Wildcards use the form `https://*.example.org`; paths, credentials, query
 * strings, fragments, and the suffix origin itself are rejected.
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
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }

    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return false
    }

    return rules.some((rule) => {
      if (parsed.protocol !== rule.protocol || parsed.port !== rule.port) {
        return false
      }

      if (!rule.wildcard) {
        return parsed.hostname === rule.hostname
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
    callback(null, origin === undefined || matchesOrigin(origin))
  }
}

function parseOriginRule(value: unknown): OriginRule {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new Error('Each CORS origin must be a non-empty string of at most 255 characters')
  }

  const wildcardMatch = /^(https?):\/\/\*\.([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value)
  if (wildcardMatch) {
    const [, protocol, hostname, port = ''] = wildcardMatch
    validateHostname(hostname)
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

function validatePort(port: string): void {
  if (port && Number(port) > 65535) {
    throw new Error(`Invalid CORS port: ${port}`)
  }
}
