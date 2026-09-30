import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'

/**
 * Create fail-closed administrative API-key middleware.
 *
 * @param configuredKey operator secret, or an empty value to disable admin access
 * @returns Express middleware that accepts only a matching `x-api-key` header
 */
export function createApiKeyAuth(configuredKey: unknown): RequestHandler {
  if (typeof configuredKey !== 'string' || configuredKey.length === 0) {
    return (req, res): void => {
      res.status(503).send({ error: 'Service not configured' })
    }
  }

  const encoder = new TextEncoder()
  const keyBytes = encoder.encode(configuredKey)
  const configuredDigest = digest(configuredKey, keyBytes)

  return (req, res, next): void => {
    const providedKey = req.headers['x-api-key']
    if (typeof providedKey !== 'string') {
      res.status(401).send({ error: 'Unauthorized' })
      return
    }

    const providedDigest = digest(providedKey, keyBytes)
    if (!timingSafeEqual(providedDigest, configuredDigest)) {
      res.status(401).send({ error: 'Unauthorized' })
      return
    }

    res.set('Cache-Control', 'no-store')
    next()
  }
}

function digest(value: string, key: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(value, 'utf8').digest())
}
