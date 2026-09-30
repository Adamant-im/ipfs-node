import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkDiskReserve,
  checkRequestSize,
  ConcurrencyLimiter,
  parseContentLength,
  RequestSizeBudget,
  RequestSizeLimitError
} from '../src/storage/limits.js'

describe('ConcurrencyLimiter', () => {
  it('admits uploads up to the configured limit', () => {
    const limiter = new ConcurrencyLimiter(2)

    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)
    assert.equal(limiter.active, 2)
  })

  it('admits a new upload once a slot is released', () => {
    const limiter = new ConcurrencyLimiter(1)

    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)

    limiter.release()
    assert.equal(limiter.tryAcquire(), true)
  })

  it('ignores a release without a matching acquire', () => {
    const limiter = new ConcurrencyLimiter(1)

    limiter.release()
    assert.equal(limiter.active, 0)
    assert.equal(limiter.tryAcquire(), true)
  })
})

describe('parseContentLength', () => {
  it('reads a declared body size', () => {
    assert.equal(parseContentLength('1024'), 1024)
  })

  it('returns undefined for a chunked or malformed request', () => {
    assert.equal(parseContentLength(undefined), undefined)
    assert.equal(parseContentLength('not-a-number'), undefined)
    assert.equal(parseContentLength('-1'), undefined)
  })
})

describe('checkRequestSize', () => {
  it('rejects a request larger than the aggregate limit', () => {
    const result = checkRequestSize(2048, 1024)

    assert.equal(result.allowed, false)
  })

  it('accepts a request at the limit', () => {
    assert.equal(checkRequestSize(1024, 1024).allowed, true)
  })

  it('accepts a request without a declared size', () => {
    assert.equal(checkRequestSize(undefined, 1024).allowed, true)
  })
})

describe('checkDiskReserve', () => {
  it('accepts an upload that leaves the reserve intact', () => {
    const result = checkDiskReserve({
      availableBytes: 1000,
      reserveBytes: 100,
      requestedBytes: 900
    })

    assert.equal(result.allowed, true)
  })

  it('rejects an upload that would consume the reserve', () => {
    const result = checkDiskReserve({
      availableBytes: 1000,
      reserveBytes: 100,
      requestedBytes: 901
    })

    assert.equal(result.allowed, false)
  })

  it('rejects any upload once free space is already below the reserve', () => {
    const result = checkDiskReserve({ availableBytes: 50, reserveBytes: 100 })

    assert.equal(result.allowed, false)
  })
})

describe('RequestSizeBudget', () => {
  it('accumulates streamed bytes across the parts of one request', () => {
    const budget = new RequestSizeBudget(10)

    budget.consume(4)
    budget.consume(6)

    assert.equal(budget.used, 10)
  })

  it('throws once the aggregate limit is passed', () => {
    const budget = new RequestSizeBudget(10)

    budget.consume(9)
    assert.throws(() => budget.consume(2), RequestSizeLimitError)
  })
})
