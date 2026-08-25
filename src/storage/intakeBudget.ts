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

/** Rolling window the budgets are measured over. */
export const INTAKE_WINDOW_MS = 60 * 60 * 1000

/** Bytes one peer may have this node pull in per window. */
export const PER_PEER_INTAKE_BYTES = 4 * 1024 ** 3

/** Requests one peer may make per window, whatever they cost. */
export const PER_PEER_INTAKE_REQUESTS = 500

/** Bytes every peer together may have this node pull in per window. */
export const TOTAL_INTAKE_BYTES = 16 * 1024 ** 3

/**
 * Requests every peer together may make per window.
 *
 * This also bounds how much the accounting itself can cost: a window can hold
 * at most this many distinct peers, so minting identities cannot grow the map
 * without also spending the shared budget.
 */
export const TOTAL_INTAKE_REQUESTS = 5000

interface Spend {
  windowStartedAt: number
  bytes: number
  requests: number
}

const perPeer = new Map<string, Spend>()
let total: Spend = { windowStartedAt: 0, bytes: 0, requests: 0 }

/** The spend for the window `now` falls in, starting a fresh one when it moved on. */
function current(spend: Spend | undefined, now: number): Spend {
  if (spend === undefined || now - spend.windowStartedAt >= INTAKE_WINDOW_MS) {
    return { windowStartedAt: now, bytes: 0, requests: 0 }
  }

  return spend
}

/** Whether a peer may ask this node to pull in one more copy. */
export function mayAcceptIntake(peerId: string, now: number = Date.now()): boolean {
  const peer = current(perPeer.get(peerId), now)
  const all = current(total, now)

  return (
    peer.bytes < PER_PEER_INTAKE_BYTES &&
    peer.requests < PER_PEER_INTAKE_REQUESTS &&
    all.bytes < TOTAL_INTAKE_BYTES &&
    all.requests < TOTAL_INTAKE_REQUESTS
  )
}

/**
 * Account for a request that was served.
 *
 * A transfer that failed is recorded as zero bytes and still counts as a
 * request, so a peer cannot spend this node's bandwidth for free by asking for
 * content that never arrives.
 */
export function recordIntake(peerId: string, bytes: number, now: number = Date.now()): void {
  const peer = current(perPeer.get(peerId), now)
  peer.bytes += bytes
  peer.requests += 1
  perPeer.set(peerId, peer)

  total = current(total, now)
  total.bytes += bytes
  total.requests += 1

  for (const [id, spend] of perPeer) {
    if (now - spend.windowStartedAt >= INTAKE_WINDOW_MS) {
      perPeer.delete(id)
    }
  }
}

/** Forget every window. For tests, where no peer is really spending anything. */
export function resetIntakeBudget(): void {
  perPeer.clear()
  total = { windowStartedAt: 0, bytes: 0, requests: 0 }
}
