import multer from 'multer'
import { RequestSizeLimitError } from '../storage/limits.js'
import { FileNotFoundError } from '../utils/fileErrors.js'

export type PublicError = {
  status: number
  body: { error: string }
}

/** Error whose constructor accepts only an approved client-facing message. */
export class InvalidRequestError extends Error {
  constructor(
    public readonly publicMessage:
      | 'Invalid CID'
      | 'Invalid peer identifier or multiaddress'
      | 'Peer identifier or multiaddress is required'
  ) {
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

  if (error instanceof FileNotFoundError) {
    return { status: 408, body: { error: 'File request timed out' } }
  }

  // Raised while streaming when the parts of one request exceed the aggregate
  // limit. The configured limit is not echoed back to the client.
  if (error instanceof RequestSizeLimitError) {
    return { status: 413, body: { error: 'Upload size limit exceeded' } }
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
  if (code === 'LIMIT_FIELD_COUNT') {
    return 'Multipart fields are not allowed'
  }
  return 'Invalid multipart upload'
}
