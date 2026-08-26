import { checkDiskReserve } from './limits.js'

/**
 * Free space promised to work that is already running.
 *
 * A single free-space reading is not a reservation. Two uploads that both see
 * a gigabyte free will both be admitted, and together they can write past the
 * disk reserve. Chunked uploads make it worse: they declare no size, so nothing
 * is subtracted for them at all and only their aggregate limit bounds what they
 * may write.
 *
 * Every admission therefore claims the bytes it might write, and the claim is
 * counted against free space until the HTTP response finishes.
 */
let claimed = 0

export interface Claim {
  /** Bytes promised to this piece of work. */
  bytes: number
  /** Give the promise back. Safe to call more than once. */
  release(): void
}

/** Bytes currently promised to work in progress. */
export function claimedBytes(): number {
  return claimed
}

export interface ClaimRequest {
  /** Bytes the work may write. */
  bytes: number
  /** Free bytes on the filesystem right now. */
  availableBytes: number
  /** Free bytes that must survive. */
  reserveBytes: number
}

/**
 * Promise space to a piece of work, if what is already promised leaves room.
 *
 * @returns The claim, or `undefined` when granting it would break the reserve
 */
export function claimSpace(request: ClaimRequest): Claim | undefined {
  const remaining = request.availableBytes - claimed
  if (
    !checkDiskReserve({
      availableBytes: remaining,
      reserveBytes: request.reserveBytes,
      requestedBytes: request.bytes
    }).allowed
  ) {
    return undefined
  }

  claimed += request.bytes
  let released = false

  return {
    bytes: request.bytes,
    release(): void {
      if (released) {
        return
      }

      released = true
      claimed = Math.max(0, claimed - request.bytes)
    }
  }
}

/** Drop every outstanding promise. For tests, where no work is really running. */
export function resetClaims(): void {
  claimed = 0
}
