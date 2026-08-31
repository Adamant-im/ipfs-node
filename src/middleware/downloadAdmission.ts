import type { RequestHandler } from 'express'

export interface DownloadConcurrencyLimiter {
  tryAcquire(): boolean
  release(): void
}

/** Build a global download concurrency guard that releases slots on every response exit. */
export function createDownloadAdmission(limiter: DownloadConcurrencyLimiter): RequestHandler {
  return (_req, res, next) => {
    if (!limiter.tryAcquire()) {
      res.set('Retry-After', '5')
      res.status(429).send({ error: 'Too many concurrent downloads. Please try again later.' })
      return
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      limiter.release()
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  }
}
