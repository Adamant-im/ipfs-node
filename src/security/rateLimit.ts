import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'
import { publicErrorBodies } from './errors.js'

export type RateLimitPolicy = {
  windowMs: number
  limit: number
}

/**
 * Create an IP-based limiter for one endpoint class.
 *
 * @param policy fixed window duration and maximum request count
 * @returns Express rate-limit middleware
 */
export function createRateLimiter(policy: RateLimitPolicy): RateLimitRequestHandler {
  validateRateLimitPolicy(policy)

  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: publicErrorBodies.rateLimited
  })
}

/**
 * Validate operator-provided rate-limit settings.
 *
 * @param policy candidate policy
 */
export function validateRateLimitPolicy(policy: RateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1) {
    throw new Error('Rate-limit windowMs must be a positive integer')
  }
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) {
    throw new Error('Rate-limit limit must be a positive integer')
  }
}
