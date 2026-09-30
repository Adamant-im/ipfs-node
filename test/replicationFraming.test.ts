import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Stream } from '@libp2p/interface'
import { readMessage } from '../src/storage/replicationProtocol.js'
import { isStalePeerSessionError } from '../src/peering/staleSessionErrors.js'

function encodeMessage(payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const frame = new Uint8Array(4 + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength)
  frame.set(body, 4)
  return frame
}

function mockStream(chunks: Uint8Array[], onAbort?: (err: Error) => void): Stream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
    abort: (err: Error) => {
      onAbort?.(err)
    }
  } as unknown as Stream
}

describe('readMessage framing', () => {
  it('reads a valid message sent in a single chunk', async () => {
    const payload = { op: 'have', cid: 'bafytest' }
    const frame = encodeMessage(payload)
    const stream = mockStream([frame])

    const message = await readMessage(stream)
    assert.deepEqual(message, payload)
  })

  it('reads a valid message fragmented across multiple chunks', async () => {
    const payload = { op: 'commit', cid: 'bafytest', transactionId: 'tx-123' }
    const frame = encodeMessage(payload)

    // Fragment into 3 parts: 2 bytes of length, next 2 bytes of length + part of body, rest of body
    const chunk1 = frame.subarray(0, 2)
    const chunk2 = frame.subarray(2, 10)
    const chunk3 = frame.subarray(10)
    const stream = mockStream([chunk1, chunk2, chunk3])

    const message = await readMessage(stream)
    assert.deepEqual(message, payload)
  })

  it('throws when stream ends before length prefix is complete', async () => {
    const stream = mockStream([new Uint8Array([0, 0, 1])]) // only 3 bytes

    await assert.rejects(
      async () => readMessage(stream),
      /Replication stream ended before a complete message arrived/
    )
  })

  it('throws when stream ends before declared payload is complete', async () => {
    const frame = new Uint8Array(10)
    new DataView(frame.buffer).setUint32(0, 20) // expects 20 bytes payload
    frame.set(new TextEncoder().encode('{"op":'), 4)
    const stream = mockStream([frame])

    await assert.rejects(
      async () => readMessage(stream),
      /Replication stream ended before a complete message arrived/
    )
  })

  it('throws when length prefix declares a message larger than MAX_MESSAGE_BYTES', async () => {
    const frame = new Uint8Array(4)
    new DataView(frame.buffer).setUint32(0, 10_000) // 10,000 > 4096
    const stream = mockStream([frame])

    await assert.rejects(async () => readMessage(stream), /Replication message is too large/)
  })

  it('throws when stream sends excessive bytes without completing a valid message', async () => {
    const excessiveChunk = new Uint8Array(5000) // > 4096 + 4
    const stream = mockStream([excessiveChunk])

    await assert.rejects(async () => readMessage(stream), /Replication message is too large/)
  })

  it('throws timeout error and aborts stream when abort signal fires', async () => {
    const controller = new AbortController()
    let abortedWithError: Error | null = null

    const stream: Stream = {
      async *[Symbol.asyncIterator]() {
        // Yield nothing and wait for abort
        await new Promise((resolve) => {
          controller.signal.addEventListener('abort', resolve)
        })
        yield new Uint8Array(0)
      },
      abort: (err: Error) => {
        abortedWithError = err
      }
    } as unknown as Stream

    const promise = readMessage(stream, controller.signal)
    controller.abort()

    await assert.rejects(async () => promise, /Replication message timed out/)
    assert.notEqual(abortedWithError, null)
    assert.equal((abortedWithError as unknown as Error).message, 'Replication message timed out')
  })

  it('throws immediately when signal is already aborted', async () => {
    const stream = mockStream([encodeMessage({ test: true })])
    const signal = AbortSignal.abort()

    await assert.rejects(async () => readMessage(stream, signal), /Replication message timed out/)
  })

  it('propagates stream reset error which is recognized as stale session error', async () => {
    const resetError = new Error('The stream has been reset')
    const stream: Stream = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(0)
        throw resetError
      },
      abort: () => {}
    } as unknown as Stream

    await assert.rejects(
      async () => readMessage(stream),
      (err: unknown) => {
        assert.equal(err, resetError)
        assert.equal(isStalePeerSessionError((err as Error).message), true)
        return true
      }
    )
  })
})
