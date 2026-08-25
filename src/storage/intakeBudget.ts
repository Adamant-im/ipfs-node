/**
 * How much of this node's bandwidth and disk peers may spend on cached copies.
 *
 * The `cache` operation is open to any peer on purpose: a node its neighbours
 * have not been configured with would otherwise keep every file uploaded to it
 * in a single copy that dies with it. Open is not the same as unbounded,
 * though. Without a budget one peer can ask for unique CIDs back to back and
 * make this node fetch them for as long as it likes, which costs bandwidth and
 * evicts the read cache of files people are actually asking for.
 *
 * There are two budgets because they answer different attacks. The per-peer one
 * bounds a single identity. The node-wide one bounds their sum, which is what
 * matters while identities are free to mint — as they are until node membership
 * is established (#28).
 *
 * Both are far above ordinary traffic: a node that just accepted an upload asks
 * two peers to cache it, and repair asks for a bounded batch per pass. They are
 * constants rather than configuration because the operator-facing limit is
 * monthly transfer accounting (#29), which supersedes them.
 */

/** Window the budgets are measured over. */
export const INTAKE_WINDOW_MS = 60 * 60 * 1000

/**
 * Slices the window is measured in.
 *
 * A single counter reset on the hour is not a rolling window: a peer spends its
 * whole allowance just before the boundary and the whole allowance again just
 * after it, so the real limit is twice what it claims to be. Buckets that
 * expire one at a time bound that overshoot to a sixth instead.
 */
export const INTAKE_BUCKETS = 6

const BUCKET_MS = INTAKE_WINDOW_MS / INTAKE_BUCKETS

/** Bytes one peer may have this node pull in per window. */
export const PER_PEER_INTAKE_BYTES = 4 * 1024 ** 3

/** Requests one peer may make per window, whatever they cost. */
export const PER_PEER_INTAKE_REQUESTS = 500

/** Bytes every peer together may have this node pull in per window. */
export const TOTAL_INTAKE_BYTES = 16 * 1024 ** 3

/**
 * Requests every peer together may make per window.
 *
 * This also bounds how much the accounting itself can cost: a window holds at
 * most this many distinct peers, so minting identities cannot grow the map
 * without also spending the shared budget.
 */
export const TOTAL_INTAKE_REQUESTS = 5000

interface Bucket {
  startedAt: number
  bytes: number
  requests: number
}

/** What one spender used over the buckets still inside the window. */
class Spend {
  private buckets: Bucket[] = []

  /** Buckets the window still covers; the rest are dropped as they age out. */
  private live(now: number): Bucket[] {
    const oldest = now - INTAKE_WINDOW_MS
    this.buckets = this.buckets.filter((bucket) => bucket.startedAt > oldest)
    return this.buckets
  }

  totals(now: number): { bytes: number; requests: number } {
    let bytes = 0
    let requests = 0

    for (const bucket of this.live(now)) {
      bytes += bucket.bytes
      requests += bucket.requests
    }

    return { bytes, requests }
  }

  /**
   * Charge the bucket `now` falls in.
   *
   * @returns The bucket charged, so a reservation can give part of it back
   */
  charge(now: number, bytes: number, requests: number): Bucket {
    const startedAt = Math.floor(now / BUCKET_MS) * BUCKET_MS
    const live = this.live(now)
    let bucket = live.find((item) => item.startedAt === startedAt)

    if (bucket === undefined) {
      bucket = { startedAt, bytes: 0, requests: 0 }
      live.push(bucket)
    }

    bucket.bytes += bytes
    bucket.requests += requests

    return bucket
  }

  spent(now: number): boolean {
    return this.live(now).length > 0
  }
}

const perPeer = new Map<string, Spend>()
let total = new Spend()

export interface IntakeReservation {
  /**
   * Correct the reservation to what the transfer really cost.
   *
   * Called with the bytes that actually crossed the network, whether or not the
   * transfer finished: a peer that sends almost everything and then aborts has
   * still spent the bandwidth.
   */
  settle(bytes: number): void
}

/**
 * Reserve the most a copy could cost, before fetching a single block.
 *
 * Checking the counters and charging them afterwards is not a limit: every
 * concurrent request reads the same figure and passes, and with eight intake
 * slots that admits eight full transfers against a budget for one. The size is
 * unknown before the transfer, so the maximum is charged up front and the
 * unused part is given back at the end.
 *
 * @returns The reservation, or `undefined` when the budget cannot cover it
 */
export function reserveIntake(
  peerId: string,
  maxBytes: number,
  now: number = Date.now()
): IntakeReservation | undefined {
  const peer = perPeer.get(peerId) ?? new Spend()
  const peerTotals = peer.totals(now)
  const allTotals = total.totals(now)

  if (
    peerTotals.bytes + maxBytes > PER_PEER_INTAKE_BYTES ||
    peerTotals.requests >= PER_PEER_INTAKE_REQUESTS ||
    allTotals.bytes + maxBytes > TOTAL_INTAKE_BYTES ||
    allTotals.requests >= TOTAL_INTAKE_REQUESTS
  ) {
    return undefined
  }

  perPeer.set(peerId, peer)

  // The request is charged now and never given back: making one is most of the
  // cost, so a transfer that fails must not be free to repeat.
  const peerBucket = peer.charge(now, maxBytes, 1)
  const totalBucket = total.charge(now, maxBytes, 1)

  if (perPeer.size > TOTAL_INTAKE_REQUESTS) {
    for (const [id, spend] of perPeer) {
      if (!spend.spent(now)) {
        perPeer.delete(id)
      }
    }
  }

  let settled = false

  return {
    settle(bytes: number): void {
      if (settled) {
        return
      }

      settled = true

      // Negative when the transfer cost less than was reserved, positive when
      // it cost more — which happens when a request may be larger than the
      // whole budget and the reservation had to be capped at it.
      const difference = Math.max(0, bytes) - maxBytes

      // A bucket that aged out in the meantime is detached from the window
      // already, so correcting it changes nothing.
      peerBucket.bytes = Math.max(0, peerBucket.bytes + difference)
      totalBucket.bytes = Math.max(0, totalBucket.bytes + difference)
    }
  }
}

/** Forget every window. For tests, where no peer is really spending anything. */
export function resetIntakeBudget(): void {
  perPeer.clear()
  total = new Spend()
}
