import { randomUUID } from 'node:crypto'
import { isAdmissionSettled, type FileRecord, type FileRegistry } from './registry.js'
import { isActiveAdmission } from './admissionState.js'

export { beginAdmission, endAdmission, isActiveAdmission } from './admissionState.js'

const processAdmissionPrefix = `${randomUUID()}:`

/** Create an upload token that can be recognized as belonging to this process. */
export function createAdmissionId(): string {
  return `${processAdmissionPrefix}${randomUUID()}`
}

/** Whether a request that can still roll this token back exists in this process. */
export function isCurrentAdmissionId(admissionId: string): boolean {
  return admissionId.startsWith(processAdmissionPrefix)
}

export interface AdmissionRecoveryReport {
  checked: number
  recovered: number
  errors: string[]
}

/**
 * Clear upload ownership left by a request that can no longer resume.
 *
 * A token whose HTTP handler is still running is skipped. An earlier process
 * cannot resume an unsettled request; retaining that token would hide a
 * confirmed pin from repair and handover forever. The same is true of an
 * unsettled token this process created after its handler returned — a failed
 * rollback or a failed settlement write. The file itself stays exactly as it
 * was; only stale transaction ownership is removed.
 *
 * A settled token is kept. Repair uses it to retry `commit` on peers that still
 * hold a prepared copy, then clears it once those copies are durable.
 */
export async function recoverInterruptedAdmissions(
  registry: FileRegistry
): Promise<AdmissionRecoveryReport> {
  const candidates = (await registry.all()).filter(
    (record) =>
      record.admissionId !== undefined &&
      !isAdmissionSettled(record) &&
      !isActiveAdmission(record.admissionId)
  )
  const report: AdmissionRecoveryReport = { checked: candidates.length, recovered: 0, errors: [] }

  for (const candidate of candidates) {
    try {
      const recovered = await registry.withExclusiveCids([candidate.cid], async (locked) => {
        const current = await locked.get(candidate.cid)

        if (
          current?.admissionId === undefined ||
          isActiveAdmission(current.admissionId) ||
          isAdmissionSettled(current)
        ) {
          return false
        }

        await locked.save({
          ...current,
          admissionId: undefined,
          admissionSettledAt: undefined
        })
        return true
      })

      if (recovered) {
        report.recovered += 1
      }
    } catch (err) {
      report.errors.push(`${candidate.cid}: ${(err as Error).message}`)
    }
  }

  return report
}

/**
 * Drop a leftover admission token once this node no longer needs it to retry
 * `commit`. Unsettled tokens and tokens whose upload request is still running
 * are left alone.
 *
 * Repair reads the record before network probes. A later upload can replace
 * `admissionId` while those probes run; clearing that newer token would strand
 * its own `commit` retry. Only the id this pass selected may be removed.
 */
export async function clearSettledAdmission(
  registry: FileRegistry,
  record: FileRecord
): Promise<void> {
  if (record.admissionId === undefined || isActiveAdmission(record.admissionId)) {
    return
  }

  await registry.withExclusiveCids([record.cid], async (locked) => {
    const current = await locked.get(record.cid)

    if (
      current === undefined ||
      current.admissionId !== record.admissionId ||
      !isAdmissionSettled(current) ||
      isActiveAdmission(current.admissionId)
    ) {
      return
    }

    await locked.save({ ...current, admissionId: undefined, admissionSettledAt: undefined })
  })
}
