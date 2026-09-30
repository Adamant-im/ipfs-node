import { CID } from 'multiformats/cid'
import { InvalidRequestError } from '../security/errors.js'

/**
 * Parse a route CID without exposing parser internals to API clients.
 *
 * @param value CID string received at the HTTP boundary
 * @returns parsed CID
 */
export function parseCid(value: string): CID {
  try {
    return CID.parse(value)
  } catch {
    throw new InvalidRequestError('Invalid CID')
  }
}
