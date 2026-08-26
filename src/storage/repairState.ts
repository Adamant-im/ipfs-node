/**
 * CIDs whose replication repair is currently doing network work.
 *
 * A repair cannot hold the registry lock across peer requests, but another
 * lifecycle must not adopt or release the CID between candidate selection and
 * placement. The marker is process-local because an interrupted repair has no
 * local state to recover after restart.
 */
const activeRepairs = new Set<string>()

/** Claim a CID for one repair pass. */
export function beginRepair(cid: string): boolean {
  if (activeRepairs.has(cid)) {
    return false
  }

  activeRepairs.add(cid)
  return true
}

/** Release repair ownership after success or failure. */
export function endRepair(cid: string): void {
  activeRepairs.delete(cid)
}

/** Whether this process is currently repairing the CID. */
export function isActiveRepair(cid: string): boolean {
  return activeRepairs.has(cid)
}
