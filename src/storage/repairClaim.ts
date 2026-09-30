import { isSettledHeldFile, type FileRecord, type FileRegistry } from './registry.js'
import { beginRepair, endRepair } from './repairState.js'

/**
 * Claim the exact registry revision selected for replication repair.
 *
 * Candidate selection happens before network probes. Taking the claim under
 * the CID lock prevents a newer upload or release from replacing that
 * lifecycle while the repair operates without holding the datastore lock.
 */
export async function claimRepairRecord(
  registry: FileRegistry,
  selected: FileRecord
): Promise<boolean> {
  return registry.withExclusiveCids([selected.cid], async (locked) => {
    const current = await locked.get(selected.cid)

    if (
      current === undefined ||
      current.revision !== selected.revision ||
      !isSettledHeldFile(current)
    ) {
      return false
    }

    return beginRepair(selected.cid)
  })
}

/** Release a claim previously returned by {@link claimRepairRecord}. */
export function releaseRepairRecord(cid: string): void {
  endRepair(cid)
}
