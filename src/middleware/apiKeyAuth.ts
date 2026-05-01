import { createHmac, timingSafeEqual } from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { config } from '../config.js'

/**
 * API key authentication middleware.
 * Protects endpoints that expose sensitive node topology information
 * (peerId, multiAddresses, disk usage).
 *
 * Key is read from config.adminApiKey.
 * Fail-secure: if no key is configured, access is blocked entirely.
 *
 * Uses crypto.timingSafeEqual to prevent timing-based key enumeration attacks.
 *
 * Usage in route: router.get('/info', apiKeyAuth, handler)
 * Client usage:   curl -H "x-api-key: <key>" http://node/api/node/info
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = config.adminApiKey as string | undefined

  // Fail-secure: block access if key is not configured
  // Prevents accidental exposure after config migration
  if (!configuredKey) {
    res.status(503).send({ error: 'Service not configured' })
    return
  }

  const providedKey = req.headers['x-api-key']

  if (!providedKey || typeof providedKey !== 'string') {
    res.status(401).send({ error: 'Unauthorized' })
    return
  }

  // Use timing-safe comparison to prevent key enumeration via response timing.
  // timingSafeEqual requires equal-length buffers — compare HMAC digests
  // (always 32 bytes for SHA-256) so length differences leak no information.
  // Use Uint8Array explicitly to satisfy TypeScript strict buffer typing.
  const encoder = new TextEncoder()
  const keyBytes = encoder.encode(configuredKey)

  const hmac = (value: string): Uint8Array => {
    const result = createHmac('sha256', keyBytes).update(encoder.encode(value)).digest()
    return new Uint8Array(result)
  }

  const providedDigest = hmac(providedKey)
  const configuredDigest = hmac(configuredKey)

  if (!timingSafeEqual(providedDigest, configuredDigest)) {
    res.status(401).send({ error: 'Unauthorized' })
    return
  }

  next()
}
