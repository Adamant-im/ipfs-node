import { CID } from 'multiformats/cid'
import { clearTimeout } from 'node:timers'
import { config } from '../config.js'
import { ifs } from '../helia.js'
import { FileNotFoundError } from './fileErrors.js'
import { createTimedReadable, type TimedReadable } from './timedStream.js'

/**
 * Return file statistics by CID.
 * Throws a timeout error if the file is not found.
 */
export async function getFileStats(cid: CID, externalSignal?: AbortSignal) {
  let timeout: NodeJS.Timeout | undefined
  try {
    const abortController = new AbortController()
    timeout = setTimeout(() => {
      abortController.abort(new Error('Cannot find requested CID. Request timed out.'))
    }, config.findFileTimeout)

    const signal = externalSignal
      ? AbortSignal.any([abortController.signal, externalSignal])
      : abortController.signal
    const stats = await ifs.stat(cid, { signal })
    return stats
  } catch {
    throw new FileNotFoundError('Cannot find requested CID. Request timed out.')
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

/**
 * Return a file stream by CID.
 * Throws a timeout error if the file is not found.
 */
export function downloadFile(
  cid: CID,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): TimedReadable {
  return createTimedReadable(
    (signal) => ifs.cat(cid, { signal }),
    options.timeoutMs ?? config.findFileTimeout,
    () => new FileNotFoundError('Unable to retrieve the file. Request timed out.'),
    options.signal
  )
}
