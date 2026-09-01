/**
 * Validation of the persisted replication-repair cycle evidence.
 *
 * Kept apart from `replication.cron.ts` so the rules can be exercised without
 * importing a module that starts a Helia node and opens the datastore.
 */

export interface RepairCycleEvidence {
  membershipVersion: string
  policyVersion: string
  cursor?: string
  startedAt: number
  /** The cycle cannot claim to have covered its candidate set. */
  superseded: boolean
  examined: number
  checked: number
  underReplicated: number
  repaired: number
  stillMissing: number
  unrecoverable: number
  lastCompletedAt: number | null
  lastCompletedSuccessfully: boolean
  lastCompletedBacklog: number
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Accept only repair evidence this node could have written.
 *
 * A negative counter or a completion stamped ahead of the clock is not merely
 * malformed: `evaluateHealth` measures repair freshness from `lastCompletedAt`,
 * so a future timestamp would read as permanently fresh and let a node with an
 * unverified registry advertise itself as ready.
 *
 * @param parsed value decoded from the datastore
 * @param now current time, used to reject state from ahead of the clock
 * @returns the evidence, or `null` when it cannot be trusted
 */
export function parseEvidence(
  parsed: Partial<RepairCycleEvidence>,
  now: number
): RepairCycleEvidence | null {
  const valid =
    typeof parsed.membershipVersion === 'string' &&
    typeof parsed.policyVersion === 'string' &&
    (parsed.cursor === undefined || typeof parsed.cursor === 'string') &&
    isCount(parsed.startedAt) &&
    parsed.startedAt <= now &&
    (parsed.examined === undefined || isCount(parsed.examined)) &&
    (parsed.superseded === undefined || typeof parsed.superseded === 'boolean') &&
    isCount(parsed.checked) &&
    isCount(parsed.underReplicated) &&
    isCount(parsed.repaired) &&
    isCount(parsed.stillMissing) &&
    isCount(parsed.unrecoverable) &&
    (parsed.lastCompletedAt === null ||
      (isCount(parsed.lastCompletedAt) && parsed.lastCompletedAt <= now)) &&
    typeof parsed.lastCompletedSuccessfully === 'boolean' &&
    isCount(parsed.lastCompletedBacklog) &&
    // A cycle cannot have checked more records than it visited, and cannot
    // report a clean completion while carrying a backlog.
    parsed.checked <= (parsed.examined ?? parsed.checked) &&
    (!parsed.lastCompletedSuccessfully || parsed.lastCompletedBacklog === 0)

  if (!valid) {
    return null
  }

  return {
    ...parsed,
    examined: parsed.examined ?? parsed.checked,
    superseded: parsed.superseded ?? false
  } as RepairCycleEvidence
}
