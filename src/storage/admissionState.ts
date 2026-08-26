/**
 * In-process set of upload tokens whose HTTP request has not finished yet.
 *
 * `admissionSettledAt` is written before remote commit. Until the handler
 * returns, that token still belongs to the request: confirm, release, a second
 * upload, and repair must not take it. A leftover after the request ends is a
 * different object — the id is no longer here.
 */

const activeAdmissions = new Set<string>()

/** Record that this process still owns the upload request for `admissionId`. */
export function beginAdmission(admissionId: string): void {
  activeAdmissions.add(admissionId)
}

/** Drop ownership when the upload request returns, succeeds or fails. */
export function endAdmission(admissionId: string): void {
  activeAdmissions.delete(admissionId)
}

/**
 * Whether the upload handler that created this token is still running.
 *
 * @param admissionId Token from a file record, or `undefined` when none
 */
export function isActiveAdmission(admissionId: string | undefined): boolean {
  return admissionId !== undefined && activeAdmissions.has(admissionId)
}
