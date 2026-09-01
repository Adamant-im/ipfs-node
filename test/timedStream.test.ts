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

    const { stream } = createTimedReadable(
      source,
      { idleTimeoutMs: 20, totalTimeoutMs: 100 },
      () => new Error('complete timeout')
    )
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
      { idleTimeoutMs: 10_000, totalTimeoutMs: 10_000 },
      () => new Error('timeout'),
      controller.signal
    )

    controller.abort(new Error('client left'))
    await assert.rejects(async () => {
      for await (const unused of stream) void unused
    }, /client left/)
  })

  it('propagates an already-aborted external signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    const { stream } = createTimedReadable(
      async function* () {
        yield Buffer.from('unexpected')
      },
      { idleTimeoutMs: 10_000, totalTimeoutMs: 10_000 },
      () => new Error('timeout'),
      controller.signal
    )

    await assert.rejects(async () => {
      for await (const unused of stream) void unused
    }, /already gone/)
  })

  it('resets the idle deadline while chunks continue arriving', async () => {
    const { stream } = createTimedReadable(
      async function* () {
        for (let index = 0; index < 3; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield Buffer.from(String(index))
        }
      },
      { idleTimeoutMs: 20, totalTimeoutMs: 100 },
      () => new Error('timeout')
    )

    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), '012')
  })
})
