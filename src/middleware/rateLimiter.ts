import { rateLimit } from 'express-rate-limit'

/**
 * Strict limiter for write operations (upload, pin).
 * 10 requests per 15 minutes per IP.
 * Prevents disk exhaustion via rapid uploads or forced pinning.
 */
export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  // Skip rate limiting for localhost — internal cron jobs and tooling
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
})

/**
 * Lenient limiter for read operations (file download, pin status checks).
 * 100 requests per minute per IP.
 */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
})
