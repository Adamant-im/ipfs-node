import { Readable } from 'node:stream'

export interface TimedReadable {
  stream: Readable
  abort: (reason?: Error) => void
}

/**
 * Create a readable whose deadline covers the complete iteration.
 *
 * The timer is cleared only when the stream ends, errors, or closes. Receiving
 * a first chunk is deliberately not success: a peer may stall mid-transfer.
 */
export function createTimedReadable(
  source: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  timeoutMs: number,
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
  externalSignal?.addEventListener('abort', externalAbort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  const guardedSource = async function* (): AsyncGenerator<Uint8Array> {
    if (controller.signal.aborted) throw controller.signal.reason
    yield* source(controller.signal)
  }
  const stream = Readable.from(guardedSource())
  const cleanup = (): void => {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', externalAbort)
  }
  stream.once('end', cleanup)
  stream.once('error', cleanup)
  stream.once('close', cleanup)
  return { stream, abort }
}
