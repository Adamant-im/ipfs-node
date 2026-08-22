/**
 * Pure upload admission helpers.
 *
 * They are deliberately free of Express, Helia and configuration imports so
 * that every boundary they guard can be exercised in isolation.
 */

/** Counts uploads that are currently writing into the blockstore. */
export class ConcurrencyLimiter {
  private inFlight = 0

  constructor(private readonly maxConcurrent: number) {}

  get active(): number {
    return this.inFlight
  }

  get limit(): number {
    return this.maxConcurrent
  }

  /** Take a slot, or return false when the node is already at capacity. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.maxConcurrent) {
      return false
    }

    this.inFlight += 1
    return true
  }

  release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1
    }
  }
}

/**
 * Read the declared body size of a request.
 * Returns `undefined` for chunked uploads, which carry no `Content-Length`.
 */
export function parseContentLength(header: string | undefined): number | undefined {
  if (header === undefined) {
    return undefined
  }

  const value = Number(header)
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }

  return value
}

export type DiskReserveInput = {
  /** Free bytes on the filesystem that holds the blockstore */
  availableBytes: number
  /** Free bytes uploads must never consume */
  reserveBytes: number
  /** Bytes the request may add, when the client declared them */
  requestedBytes?: number
}

export type AdmissionResult = { allowed: true } | { allowed: false; reason: string }

/**
 * Decide whether an upload may start without eating into the disk reserve.
 *
 * The declared request size is subtracted up front so that content is rejected
 * before a single block is written, instead of after the blockstore has already
 * grown past the reserve.
 */
export function checkDiskReserve(input: DiskReserveInput): AdmissionResult {
  const requested = input.requestedBytes ?? 0
  const remaining = input.availableBytes - requested

  if (remaining < input.reserveBytes) {
    return {
      allowed: false,
      reason:
        `Insufficient storage. Free space ${input.availableBytes} bytes, ` +
        `requested ${requested} bytes, reserve ${input.reserveBytes} bytes.`
    }
  }

  return { allowed: true }
}

/** Reject a request whose declared body already exceeds the aggregate limit. */
export function checkRequestSize(
  declaredBytes: number | undefined,
  maxRequestSizeBytes: number
): AdmissionResult {
  if (declaredBytes !== undefined && declaredBytes > maxRequestSizeBytes) {
    return {
      allowed: false,
      reason: `Request size limit exceeded. Max ${maxRequestSizeBytes} bytes allowed.`
    }
  }

  return { allowed: true }
}

export class RequestSizeLimitError extends Error {
  constructor(public readonly maxRequestSizeBytes: number) {
    super(`Request size limit exceeded. Max ${maxRequestSizeBytes} bytes allowed.`)
    this.name = 'RequestSizeLimitError'
  }
}

/**
 * Aggregate byte budget shared by every file of a single multipart request.
 *
 * `Content-Length` alone is not enough: chunked requests declare no size, so the
 * budget is also enforced while the parts are being streamed.
 */
export class RequestSizeBudget {
  private consumed = 0

  constructor(private readonly maxRequestSizeBytes: number) {}

  get used(): number {
    return this.consumed
  }

  /** Account for streamed bytes. Throws once the aggregate limit is passed. */
  consume(bytes: number): void {
    this.consumed += bytes

    if (this.consumed > this.maxRequestSizeBytes) {
      throw new RequestSizeLimitError(this.maxRequestSizeBytes)
    }
  }
}
