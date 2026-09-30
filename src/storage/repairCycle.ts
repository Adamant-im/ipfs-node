import { isLifecycleBusy, type FileRecord, type FileRegistry } from './registry.js'
import { SWEEP_BATCHES } from './sweep.js'

/**
 * Catch-up rounds a cycle may append before it stops trying to converge.
 *
 * Each round only has to cover what arrived during the previous one, so the
 * work shrinks quickly. The bound is what stops a node under sustained upload
 * load from extending one cycle indefinitely.
 */
const MAX_CATCH_UP_ROUNDS = 3

export interface RepairCycleBatch {
  /** CIDs this pass should visit, in cycle order. */
  cids: string[]
  /** True when this pass ended a cycle, covered or not. */
  cycleCompleted: boolean
  /** Cursor to persist so a restart can resume this cycle. */
  nextCursor?: string
  /**
   * Candidates admitted during the cycle that it could not cover.
   *
   * Non-zero only when the catch-up rounds ran out, which is the caller's
   * signal that the finished cycle is not evidence about the whole set.
   */
  uncovered: number
  /**
   * Whether a completed cycle may be claimed to have covered its candidate set.
   *
   * False once a restart resumed the cycle from its persisted cursor: the
   * rebuilt list cannot tell a record admitted during the downtime from one the
   * lost passes already visited, so both sit below the cursor and neither shows
   * up as a late arrival.
   */
  coverageProven: boolean
}

interface RepairCycle {
  /** Candidate CIDs this cycle committed to covering, in visit order. */
  cids: string[]
  /** How many of them have been handed out. */
  index: number
  refreshes: number
  /** The list was rebuilt from a cursor, so its prefix is not proven covered. */
  resumed: boolean
}

/**
 * Candidate list of the cycle in progress.
 *
 * Held in memory rather than persisted: at production sizes the list is far too
 * large for a datastore value, and losing it costs one rebuild. A restart
 * rebuilds it and resumes from the persisted cursor.
 */
let cycle: RepairCycle | undefined

/** Forget the cycle in progress, so the next pass starts a new one. */
export function resetRepairCycle(): void {
  cycle = undefined
}

function isCandidate(record: FileRecord): boolean {
  return record.state === 'confirmed' && !isLifecycleBusy(record)
}

/** Read the current candidate set, ordered the way a cycle walks it. */
async function candidateCids(registry: FileRegistry): Promise<string[]> {
  const cids = (await registry.all()).filter(isCandidate).map((record) => record.cid)

  // Code-unit ordering, matching the cursor comparison in `resumeIndex`.
  return cids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** Locate the persisted cursor in a freshly built list, after a restart. */
function resumeIndex(cids: string[], cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0
  }

  const exact = cids.indexOf(cursor)
  if (exact >= 0) {
    return exact + 1
  }

  // The cursor record left the candidate set. Resume at the first CID strictly
  // greater so the pass does not rewind to the head.
  const next = cids.findIndex((cid) => cid > cursor)
  return next >= 0 ? next : cids.length
}

/**
 * Take the next bounded batch of the repair cycle.
 *
 * The candidate set is read once per cycle instead of once per pass: a full
 * cycle over `N` records used to scan and sort the whole registry `N / 50`
 * times. Slicing a committed list also makes coverage decidable — reaching the
 * end means every CID the cycle committed to was handed out.
 *
 * Records that arrived while the cycle was walking are not in that list, so one
 * scan at the end names them. They are appended and covered by the same cycle
 * where possible, because discarding a finished cycle on every upload would
 * stop `repairFresh` from ever advancing on a busy node.
 *
 * @param registry lifecycle registry to read candidates from
 * @param cursor CID the previous pass stopped at, or `undefined` to start a cycle
 * @returns the batch, the cycle boundary, and any candidates left uncovered
 */
export async function nextRepairCycleBatch(
  registry: FileRegistry,
  cursor: string | undefined
): Promise<RepairCycleBatch> {
  if (cycle === undefined || cursor === undefined) {
    const cids = await candidateCids(registry)
    // Rebuilding from a cursor cannot reconstruct what the lost passes visited.
    cycle = { cids, index: resumeIndex(cids, cursor), refreshes: 0, resumed: cursor !== undefined }
  }

  const coverageProven = !cycle.resumed
  const batch = cycle.cids.slice(cycle.index, cycle.index + SWEEP_BATCHES.repair)
  cycle.index += batch.length

  if (cycle.index < cycle.cids.length) {
    return {
      cids: batch,
      cycleCompleted: false,
      nextCursor: batch.at(-1) ?? cursor,
      uncovered: 0,
      coverageProven
    }
  }

  // End of the committed list. One scan decides whether the cycle covered the
  // set it set out to cover, or whether records arrived behind it.
  const committed = new Set(cycle.cids)
  const fresh = (await candidateCids(registry)).filter((cid) => !committed.has(cid))

  if (fresh.length === 0) {
    cycle = undefined
    return { cids: batch, cycleCompleted: true, uncovered: 0, coverageProven }
  }

  if (cycle.refreshes < MAX_CATCH_UP_ROUNDS) {
    cycle.cids.push(...fresh)
    cycle.refreshes += 1

    return {
      cids: batch,
      cycleCompleted: false,
      nextCursor: batch.at(-1) ?? cursor,
      uncovered: 0,
      coverageProven
    }
  }

  cycle = undefined
  return { cids: batch, cycleCompleted: true, uncovered: fresh.length, coverageProven }
}
