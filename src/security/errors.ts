import multer from 'multer'

export type PublicError = {
  status: number
  body: { error: string }
}

/** Error whose constructor accepts only an approved client-facing message. */
export class InvalidRequestError extends Error {
  constructor(public readonly publicMessage: 'Invalid CID') {
    super(publicMessage)
  }
}

/**
 * Map thrown values to an HTTP response without exposing dependency messages,
 * stack traces, paths, or other internal details.
 *
 * @param error value forwarded to the Express error handler
 * @returns controlled status and JSON body
 */
export function getPublicError(error: unknown): PublicError {
  if (error instanceof InvalidRequestError) {
    return { status: 400, body: { error: error.publicMessage } }
  }

  if (error instanceof multer.MulterError) {
    return { status: 400, body: { error: multerErrorMessage(error.code) } }
  }

  return { status: 500, body: { error: 'Internal Server Error' } }
}

function multerErrorMessage(code: string): string {
  if (code === 'LIMIT_FILE_SIZE') {
    return 'Upload size limit exceeded'
  }
  if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT') {
    return 'Upload file count limit exceeded'
  }
  return 'Invalid multipart upload'
}
