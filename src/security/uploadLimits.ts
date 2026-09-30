export type MultipartLimits = {
  fileSize: number
  files: number
  fields: number
  parts: number
}

/**
 * Build streaming multipart limits. Busboy emits its part-count error when the
 * configured value is reached, so one sentinel part is required to accept the
 * documented maximum number of file parts.
 *
 * @param fileSize maximum bytes accepted for one file
 * @param fileCount maximum files accepted in one request
 * @returns Multer/Busboy limits that reject non-file fields and excess files
 */
export function createMultipartLimits(fileSize: number, fileCount: number): MultipartLimits {
  return {
    fileSize,
    files: fileCount,
    fields: 0,
    parts: fileCount + 1
  }
}
