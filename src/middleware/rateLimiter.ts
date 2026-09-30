import { config } from '../config.js'
import { createRateLimiter, type RateLimitPolicy } from '../security/rateLimit.js'

const uploadPolicy: RateLimitPolicy = config.rateLimits?.upload ?? {
  windowMs: 15 * 60 * 1000,
  limit: 10
}

const pinPolicy: RateLimitPolicy = config.rateLimits?.pin ?? {
  windowMs: 15 * 60 * 1000,
  limit: 10
}

const readPolicy: RateLimitPolicy = config.rateLimits?.read ?? {
  windowMs: 60 * 1000,
  limit: 100
}

/**
 * Endpoint-specific limiter for public multipart uploads.
 */
export const uploadLimiter = createRateLimiter(uploadPolicy)

/**
 * Strict limiter for explicit administrative pin requests.
 */
export const pinLimiter = createRateLimiter(pinPolicy)

/**
 * Lenient limiter for read operations (file download, pin status checks).
 * 100 requests per minute per IP.
 */
export const readLimiter = createRateLimiter(readPolicy)
