import type { ErrorRequestHandler, RequestHandler } from 'express'
import { getPublicError } from '../security/errors.js'
import { logger } from '../utils/logger.js'

/** Return a generic response for routes outside the documented API surface. */
export const notFoundHandler: RequestHandler = (req, res): void => {
  res.status(404).send({ error: 'Not found' })
}

/**
 * Log complete errors server-side while returning only controlled messages.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next): void => {
  if (res.headersSent) {
    next(err)
    return
  }

  logger.error(err)
  const publicError = getPublicError(err)
  res.status(publicError.status).send(publicError.body)
}
