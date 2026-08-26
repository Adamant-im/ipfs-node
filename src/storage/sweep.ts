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

/**
 * Take the next batch of a periodic sweep, continuing where it left off.
 *
 * Slicing from the front would examine the same files on every pass and never
 * reach the rest, so the batch wraps around the end and the cursor moves with
 * A cursor pointing at a record that has since gone resumes at the first
 * remaining CID greater than it, so a successful demote/rescue of the last
 * batch element does not rewind to the head.
 *
 * @param sweep Which sweep is asking; each keeps its own position
 * @param records Every candidate, in a stable order
 * @param options `advance: false` reports the next batch without taking it, for
 *   a dry run that must not move the position the real pass resumes from
 */
export function nextSweepBatch<T extends { cid: string }>(
  sweep: SweepName,
  records: T[],
  options: { advance?: boolean } = {}
): T[] {
  const size = SWEEP_BATCHES[sweep]
  const advance = options.advance !== false

  if (records.length <= size) {
    if (advance) {
      cursors.delete(sweep)
    }

    return records
  }

  const previous = cursors.get(sweep)
  let start = 0

  if (previous !== undefined) {
    const exact = records.findIndex((item) => item.cid === previous)
    if (exact >= 0) {
      start = exact + 1
    } else {
      // The cursor record left the candidate set (the usual success path for
      // demote/rescue). Resume at the first CID strictly greater so the pass
      // does not rewind to the head.
      const next = records.findIndex((item) => item.cid > previous)
      start = next >= 0 ? next : 0
    }
  }

  if (start >= records.length) {
    start = 0
  }

  const batch = [...records.slice(start), ...records.slice(0, start)].slice(0, size)

  if (advance) {
    cursors.set(sweep, batch[batch.length - 1].cid)
  }

  return batch
}
