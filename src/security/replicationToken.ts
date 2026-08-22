import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'

/**
 * Create fail-closed middleware for peer replication requests.
 *
 * The token is shared by the ADAMANT nodes and authorizes exactly one
 * operation: storing a copy of a CID. It is deliberately separate from
 * `adminApiKey`, which would grant a peer far more than replication needs.
 *
 * @param configuredToken operator secret, or an empty value to refuse replication
 * @returns Express middleware that accepts only a matching `x-replication-token` header
 */
export function createReplicationAuth(configuredToken: unknown): RequestHandler {
  if (typeof configuredToken !== 'string' || configuredToken.length === 0) {
    return (req, res): void => {
      res.status(503).send({ error: 'Service not configured' })
    }
  }

  const keyBytes = new TextEncoder().encode(configuredToken)
  const configuredDigest = digest(configuredToken, keyBytes)

  return (req, res, next): void => {
    const provided = req.headers['x-replication-token']
    if (typeof provided !== 'string') {
      res.status(401).send({ error: 'Unauthorized' })
      return
    }

    if (!timingSafeEqual(digest(provided, keyBytes), configuredDigest)) {
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
