import { Readable } from 'node:stream'

export interface TimedReadable {
  stream: Readable
  abort: (reason?: Error) => void
}

export interface StreamTimeouts {
  /** Maximum time without receiving another chunk. */
  idleTimeoutMs: number
  /** Maximum time for the complete iteration. */
  totalTimeoutMs: number
}

/**
 * Create a readable whose deadline covers the complete iteration.
 *
 * The timer is cleared only when the stream ends, errors, or closes. Receiving
 * a first chunk is deliberately not success: a peer may stall mid-transfer.
 */
export function createTimedReadable(
  source: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  timeouts: StreamTimeouts,
  timeoutError: () => Error,
  externalSignal?: AbortSignal
): TimedReadable {
  const controller = new AbortController()
  let aborted = false
  const abort = (reason = timeoutError()): void => {
    if (aborted) return
    aborted = true
    controller.abort(reason)
  }
  const externalAbort = (): void =>
    abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new Error('Stream request was cancelled')
    )
  if (externalSignal?.aborted) externalAbort()
  else externalSignal?.addEventListener('abort', externalAbort, { once: true })
  const totalTimer = setTimeout(abort, timeouts.totalTimeoutMs)
  let idleTimer = setTimeout(abort, timeouts.idleTimeoutMs)
  const guardedSource = async function* (): AsyncGenerator<Uint8Array> {
    if (controller.signal.aborted) throw controller.signal.reason
    for await (const chunk of source(controller.signal)) {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(abort, timeouts.idleTimeoutMs)
      yield chunk
    }
  }
  const stream = Readable.from(guardedSource())
  const cleanup = (): void => {
    clearTimeout(totalTimer)
    clearTimeout(idleTimer)
    externalSignal?.removeEventListener('abort', externalAbort)
  }
  stream.once('end', cleanup)
  stream.once('error', cleanup)
  stream.once('close', cleanup)
  return { stream, abort }
}
