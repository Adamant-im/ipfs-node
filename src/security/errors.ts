import multer from 'multer'
import { RequestSizeLimitError } from '../storage/limits.js'
import { FileLifecycleBusyError } from '../storage/registry.js'
import { FileNotFoundError } from '../utils/fileErrors.js'

/** JSON body of a client-facing error. `code` is set on operational upload and read failures. */
export type PublicErrorBody = {
  error: string
  code?: string
}

export type PublicError = {
  status: number
  body: PublicErrorBody
}

/**
 * Stable bodies for failures a client can branch on.
 * The `error` text stays the historical message; `code` is the identifier.
 */
export const publicErrorBodies = {
  rateLimited: {
    error: 'Too many requests. Please try again later.',
    code: 'rate_limited'
  },
  uploadConcurrency: {
    error: 'Too many concurrent uploads. Please try again later.',
    code: 'upload_concurrency'
  },
  downloadConcurrency: {
    error: 'Too many concurrent downloads. Please try again later.',
    code: 'download_concurrency'
  },
  downloadClientConcurrency: {
    error: 'Too many concurrent downloads from this client. Please try again later.',
    code: 'download_client_concurrency'
  },
  requestTooLarge: {
    error: 'Upload size limit exceeded',
    code: 'request_too_large'
  },
  fileTooLarge: {
    error: 'Upload size limit exceeded',
    code: 'file_too_large'
  },
  tooManyFiles: {
    error: 'Upload file count limit exceeded',
    code: 'too_many_files'
  },
  multipartFields: {
    error: 'Multipart fields are not allowed',
    code: 'multipart_fields'
  },
  invalidMultipart: {
    error: 'Invalid multipart upload',
    code: 'invalid_multipart'
  },
  insufficientStorage: {
    error: 'Insufficient storage',
    code: 'insufficient_storage'
  },
  replicationQuorum: {
    error: 'Replication quorum not reached',
    code: 'replication_quorum'
  },
  fileTimeout: {
    error: 'File request timed out',
    code: 'file_timeout'
  },
  lifecycleBusy: {
    error: 'File lifecycle is busy',
    code: 'lifecycle_busy'
  },
  noFile: {
    error: 'No file uploaded',
    code: 'no_file'
  }
} as const satisfies Record<string, PublicErrorBody>

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
    return { status: 408, body: publicErrorBodies.fileTimeout }
  }

  if (error instanceof FileLifecycleBusyError) {
    return { status: 409, body: publicErrorBodies.lifecycleBusy }
  }

  // Raised while streaming when the parts of one request exceed the aggregate
  // limit. The configured limit is not echoed back to the client.
  if (error instanceof RequestSizeLimitError) {
    return { status: 413, body: publicErrorBodies.requestTooLarge }
  }

  if (error instanceof multer.MulterError) {
    return { status: 400, body: multerErrorBody(error.code) }
  }

  return { status: 500, body: { error: 'Internal Server Error' } }
}

function multerErrorBody(code: string): PublicErrorBody {
  if (code === 'LIMIT_FILE_SIZE') {
    return publicErrorBodies.fileTooLarge
  }
  if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT') {
    return publicErrorBodies.tooManyFiles
  }
  if (code === 'LIMIT_FIELD_COUNT') {
    return publicErrorBodies.multipartFields
  }
  return publicErrorBodies.invalidMultipart
}
