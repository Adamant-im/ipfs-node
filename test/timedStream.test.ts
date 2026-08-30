import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTimedReadable } from '../src/utils/timedStream.js'

describe('complete stream deadline', () => {
  it('aborts a transfer that stalls after its first chunk', async () => {
    async function* source(signal: AbortSignal): AsyncGenerator<Uint8Array> {
      yield Buffer.from('first')
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }

    const { stream } = createTimedReadable(source, 20, () => new Error('complete timeout'))
    const chunks: Buffer[] = []

    await assert.rejects(async () => {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    }, /complete timeout/)
    assert.equal(Buffer.concat(chunks).toString(), 'first')
  })

  it('propagates external cancellation before the deadline', async () => {
    const controller = new AbortController()
    async function* source(signal: AbortSignal): AsyncGenerator<Uint8Array> {
      if (signal.aborted) throw signal.reason
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      yield Buffer.alloc(0)
    }
    const { stream } = createTimedReadable(
      source,
      10_000,
      () => new Error('timeout'),
      controller.signal
    )

    controller.abort(new Error('client left'))
    await assert.rejects(async () => {
      for await (const unused of stream) void unused
    }, /client left/)
  })
})
