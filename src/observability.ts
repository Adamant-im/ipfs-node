import type { RequestHandler } from 'express'

interface HttpMetrics {
  requests: number
  responses: Record<'2xx' | '3xx' | '4xx' | '5xx', number>
  inFlight: number
  totalResponseTimeMs: number
  maxResponseTimeMs: number
}

const metrics: HttpMetrics = {
  requests: 0,
  responses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  inFlight: 0,
  totalResponseTimeMs: 0,
  maxResponseTimeMs: 0
}

/** Bounded HTTP counters with no path, CID, IP, or user-controlled labels. */
export const collectHttpMetrics: RequestHandler = (req, res, next) => {
  void req
  const started = performance.now()
  let settled = false
  metrics.requests += 1
  metrics.inFlight += 1

  const settle = (): void => {
    if (settled) return
    settled = true
    metrics.inFlight -= 1
    const elapsed = performance.now() - started
    metrics.totalResponseTimeMs += elapsed
    metrics.maxResponseTimeMs = Math.max(metrics.maxResponseTimeMs, elapsed)
    const group = `${Math.floor(res.statusCode / 100)}xx` as keyof HttpMetrics['responses']
    if (group in metrics.responses) metrics.responses[group] += 1
  }
  res.once('finish', settle)
  res.once('close', settle)
  next()
}

/** Snapshot suitable for the authenticated operator details endpoint. */
export function getHttpMetrics(): HttpMetrics & { averageResponseTimeMs: number } {
  const completedResponses = Object.values(metrics.responses).reduce(
    (total, count) => total + count,
    0
  )

  return {
    ...metrics,
    responses: { ...metrics.responses },
    averageResponseTimeMs:
      completedResponses === 0 ? 0 : metrics.totalResponseTimeMs / completedResponses
  }
}
