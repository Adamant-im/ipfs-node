import type { Request, RequestHandler } from 'express'

export interface DownloadConcurrencyLimiter {
  tryAcquire(): boolean
  release(): void
}

export interface DownloadAdmissionOptions {
  /**
   * In-flight downloads one client address may hold at once.
   *
   * The global limiter alone bounds what the node spends, not who spends it:
   * a download slot is held for as long as the transfer runs, so without a
   * per-client share one address can take every slot and leave the rest of
   * the network with `429` until those transfers end.
   */
  perClientLimit?: number
  /** Client identity; defaults to the address Express resolved under `trust proxy`. */
  clientKey?: (req: Request) => string
}

/** Build a download concurrency guard that releases slots on every response exit. */
export function createDownloadAdmission(
  limiter: DownloadConcurrencyLimiter,
  options: DownloadAdmissionOptions = {}
): RequestHandler {
  const { perClientLimit } = options
  const clientKey = options.clientKey ?? ((req: Request) => req.ip ?? 'unknown')

  // An entry exists only while its client holds a global slot, so this map is
  // bounded by the global limit and never accumulates addresses.
  const heldPerClient = new Map<string, number>()

  return (req, res, next) => {
    const key = clientKey(req)
    const held = heldPerClient.get(key) ?? 0

    if (perClientLimit !== undefined && held >= perClientLimit) {
      res.set('Retry-After', '5')
      res
        .status(429)
        .send({ error: 'Too many concurrent downloads from this client. Please try again later.' })
      return
    }

    if (!limiter.tryAcquire()) {
      res.set('Retry-After', '5')
      res.status(429).send({ error: 'Too many concurrent downloads. Please try again later.' })
      return
    }

    heldPerClient.set(key, held + 1)

    let released = false
    const release = (): void => {
      if (released) return
      released = true

      const remaining = (heldPerClient.get(key) ?? 1) - 1
      if (remaining > 0) {
        heldPerClient.set(key, remaining)
      } else {
        heldPerClient.delete(key)
      }

      limiter.release()
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  }
}
