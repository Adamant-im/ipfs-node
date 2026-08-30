/**
 * How many files each periodic sweep looks at per pass.
 *
 * Every sweep asks peers something, so an unbounded one turns a node with many
 * records into a source of steady chatter. Repair may transfer a file, so it
 * gets the smallest batch; the others only exchange short messages.
 */
export const SWEEP_BATCHES = { repair: 50, demote: 200, rescue: 50 }

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
 * that every candidate present in that ordered cycle was visited.
 */
export function sweepBatch<T extends { cid: string }>(
  sweep: SweepName,
  records: T[],
  cursor?: string
): SweepBatch<T> {
  const size = SWEEP_BATCHES[sweep]
  const ordered = [...records].sort((left, right) => left.cid.localeCompare(right.cid))
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
 * successful demote/rescue of the last batch element does not rewind to the head.
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
