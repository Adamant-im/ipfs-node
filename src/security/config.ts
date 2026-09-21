import { createOriginMatcher } from './cors.js'
import { validateRateLimitPolicy, type RateLimitPolicy } from './rateLimit.js'
import { parseTrustProxy } from './trustProxy.js'

const insecureApiKeys = new Set([
  'change-me-use-openssl-rand-hex-32',
  'replace-with-output-of-openssl-rand-hex-32',
  'your-generated-key-here'
])

type SecurityConfigInput = {
  cors?: { allowedOrigins?: unknown }
  trustProxy?: unknown
  adminApiKey?: unknown
  enableDebugApi?: unknown
  rateLimits?: Partial<Record<'upload' | 'pin' | 'read', RateLimitPolicy>>
  uploadLimitSizeBytes?: unknown
  maxFileCount?: unknown
}

/**
 * Validate configuration values that define HTTP security boundaries.
 * Missing optional admin and proxy settings fail closed at runtime.
 *
 * @param config parsed application configuration
 */
export function validateSecurityConfig(config: SecurityConfigInput): void {
  createOriginMatcher(config.cors?.allowedOrigins)
  parseTrustProxy(config.trustProxy)

  if (config.adminApiKey !== undefined && config.adminApiKey !== '') {
    if (
      typeof config.adminApiKey !== 'string' ||
      config.adminApiKey.length < 32 ||
      insecureApiKeys.has(config.adminApiKey)
    ) {
      throw new Error(
        'adminApiKey must be an empty value or a unique secret of at least 32 characters'
      )
    }
  }

  if (config.enableDebugApi !== undefined && typeof config.enableDebugApi !== 'boolean') {
    throw new Error('enableDebugApi must be a boolean')
  }

  if (
    typeof config.uploadLimitSizeBytes !== 'number' ||
    !Number.isSafeInteger(config.uploadLimitSizeBytes) ||
    config.uploadLimitSizeBytes < 1
  ) {
    throw new Error('uploadLimitSizeBytes must be a positive integer')
  }

  if (
    typeof config.maxFileCount !== 'number' ||
    !Number.isSafeInteger(config.maxFileCount) ||
    config.maxFileCount < 1 ||
    config.maxFileCount > 100
  ) {
    throw new Error('maxFileCount must be an integer from 1 through 100')
  }

  for (const name of ['upload', 'pin', 'read'] as const) {
    const policy = config.rateLimits?.[name] as RateLimitPolicy | undefined
    if (policy !== undefined) {
      validateRateLimitPolicy(policy)
    }
  }
}
