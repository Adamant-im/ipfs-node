import { randomUUID } from 'node:crypto'
import type { FileRegistry } from './registry.js'

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
 * Clear upload ownership left by a process that stopped before cleanup.
 *
 * A current-process token is skipped because its request can still compensate
 * the record. A previous process cannot resume that request; retaining its token
 * would hide a confirmed pin from repair and handover forever. The file itself
 * stays exactly as it was — only stale transaction ownership is removed.
 */
export async function recoverInterruptedAdmissions(
  registry: FileRegistry
): Promise<AdmissionRecoveryReport> {
  const candidates = (await registry.all()).filter(
    (record) => record.admissionId !== undefined && !isCurrentAdmissionId(record.admissionId)
  )
  const report: AdmissionRecoveryReport = { checked: candidates.length, recovered: 0, errors: [] }

  for (const candidate of candidates) {
    try {
      const recovered = await registry.withExclusiveCids([candidate.cid], async (locked) => {
        const current = await locked.get(candidate.cid)

        if (current?.admissionId === undefined || isCurrentAdmissionId(current.admissionId)) {
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
