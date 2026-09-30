import type { RequestHandler } from 'express'

/**
 * Counters accumulated since process start.
 *
 * They are deliberately not a sliding window: a window needs retained samples,
 * and the point of this module is a fixed-size report. `averageResponseTimeMs`
 * is therefore a lifetime figure, useful as a trend and not as a current
 * latency reading. A collector scraping `GET /api/node/details` derives rates
 * by differencing consecutive samples.
 */
interface HttpMetrics {
  requests: number
  responses: Record<'2xx' | '3xx' | '4xx' | '5xx', number>
  /** Responses whose connection closed before the body was finished. */
  aborted: number
  inFlight: number
  totalResponseTimeMs: number
  maxResponseTimeMs: number
}

const metrics: HttpMetrics = {
  requests: 0,
  responses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  aborted: 0,
  inFlight: 0,
  totalResponseTimeMs: 0,
  maxResponseTimeMs: 0
}

/** Bounded HTTP counters with no path, CID, IP, or user-controlled labels. */
export const collectHttpMetrics: RequestHandler = (_req, res, next) => {
  const started = performance.now()
  let settled = false
  metrics.requests += 1
  metrics.inFlight += 1

  const settle = (completed: boolean): void => {
    if (settled) return
    settled = true
    metrics.inFlight -= 1
    const elapsed = performance.now() - started
    metrics.totalResponseTimeMs += elapsed
    metrics.maxResponseTimeMs = Math.max(metrics.maxResponseTimeMs, elapsed)

    // A download sends `200` with its first chunk and can still fail or be
    // cancelled mid-body. Counting that close in the status family would report
    // a truncated transfer as a success and hide the late failures this report
    // exists to surface, so only a finished body reaches a family counter.
    if (!completed) {
      metrics.aborted += 1
      return
    }

    const group = `${Math.floor(res.statusCode / 100)}xx` as keyof HttpMetrics['responses']
    if (group in metrics.responses) metrics.responses[group] += 1
  }
  res.once('finish', () => settle(true))
  res.once('close', () => settle(res.writableFinished))
  next()
}

/** Snapshot suitable for the authenticated operator details endpoint. */
export function getHttpMetrics(): HttpMetrics & { averageResponseTimeMs: number } {
  const settledResponses =
    Object.values(metrics.responses).reduce((total, count) => total + count, 0) + metrics.aborted

  return {
    ...metrics,
    responses: { ...metrics.responses },
    averageResponseTimeMs:
      settledResponses === 0 ? 0 : metrics.totalResponseTimeMs / settledResponses
  }
}
