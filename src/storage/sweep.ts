/**
 * How many files each periodic sweep looks at per pass.
 *
 * The batch caps memory, fan-out, and work claimed by one pass. Repair chains
 * passes until a cycle completes; `repairBatchDelayMs` and probe concurrency
 * separately control its sustained peer traffic.
 */
export const SWEEP_BATCHES = { repair: 50, demote: 200 }

export type SweepName = keyof typeof SWEEP_BATCHES

/** Where each sweep stopped last time, so the next pass continues from there. */
const cursors = new Map<SweepName, string>()

export interface SweepBatch<T> {
  records: T[]
  /** True when this batch reached the end of one complete sorted sweep. */
  cycleCompleted: boolean
  /** Cursor to persist for the next pass; absent after a completed cycle. */
  nextCursor?: string
}

/**
 * Select one non-wrapping batch and expose its cycle boundary.
 *
 * A persisted cursor may be supplied after restart. A batch never mixes the
 * tail of one cycle with the head of the next, so completing a batch proves
 * that every candidate present **when the cycle began** was visited: CIDs are
 * immutable, so a record that existed then either sorts before the cursor and
 * was already visited, or sorts after it and still will be.
 *
 * It proves nothing about records admitted mid-cycle. Replication repair needs
 * that guarantee and tracks it in `repairCycle.ts`, which commits to a candidate
 * list once and reports what arrived behind it; this sweep stays the simple
 * position-keeping used by demotion.
 *
 * @param sweep which sweep is asking; selects the batch size
 * @param records every current candidate
 * @param cursor CID the previous pass of this cycle stopped at
 */
export function sweepBatch<T extends { cid: string }>(
  sweep: SweepName,
  records: T[],
  cursor?: string
): SweepBatch<T> {
  const size = SWEEP_BATCHES[sweep]
  // Cursor lookup below uses JavaScript code-unit ordering. Keep sorting on the
  // same deterministic relation instead of the host's locale-dependent ICU rules.
  const ordered = [...records].sort((left, right) =>
    left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0
  )
  let start = 0

  if (cursor !== undefined) {
    const exact = ordered.findIndex((item) => item.cid === cursor)
    if (exact >= 0) {
      start = exact + 1
    } else {
      const next = ordered.findIndex((item) => item.cid > cursor)
      start = next >= 0 ? next : ordered.length
    }
  }

  if (start >= ordered.length) {
    return { records: [], cycleCompleted: true }
  }

  const batch = ordered.slice(start, start + size)
  const cycleCompleted = start + batch.length >= ordered.length
  return {
    records: batch,
    cycleCompleted,
    nextCursor: cycleCompleted ? undefined : batch.at(-1)?.cid
  }
}

/**
 * Take the next batch of a periodic sweep, continuing where it left off.
 *
 * Slicing from the front would examine the same files on every pass and never
 * reach the rest, so the batch wraps around the end and the cursor moves with
 * it. Candidates are sorted by CID first: resume compares CIDs lexicographically,
 * and datastore listing order is not sorted. A cursor pointing at a record that
 * has since gone resumes at the first remaining CID greater than it, so a
 * successful demotion of the last batch element does not rewind to the head.
 *
 * @param sweep Which sweep is asking; each keeps its own position
 * @param records Every candidate; order is ignored and replaced by CID order
 * @param options `advance: false` reports the next batch without taking it, for
 *   a dry run that must not move the position the real pass resumes from
 */
export function nextSweepBatch<T extends { cid: string }>(
  sweep: SweepName,
  records: T[],
  options: { advance?: boolean } = {}
): T[] {
  const advance = options.advance !== false
  let selected = sweepBatch(sweep, records, cursors.get(sweep))

  // The prior cursor can sort after every current candidate when records were
  // deleted or replaced. Start a new cycle instead of returning an empty pass.
  if (selected.records.length === 0 && records.length > 0) {
    selected = sweepBatch(sweep, records)
  }

  if (advance) {
    if (selected.nextCursor === undefined) {
      cursors.delete(sweep)
    } else {
      cursors.set(sweep, selected.nextCursor)
    }
  }

  return selected.records
}
