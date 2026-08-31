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
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error
    throw new FileNotFoundError('Cannot find requested CID. Request timed out.')
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

/**
 * Return a file stream with idle and size-aware complete-transfer deadlines.
 *
 * @param cid Content identifier to retrieve
 * @param fileSize Stat result used to derive a deadline that permits large active transfers
 * @param options Request cancellation and test/operator timeout overrides
 */
export function downloadFile(
  cid: CID,
  fileSize: bigint,
  options: { signal?: AbortSignal; idleTimeoutMs?: number; totalTimeoutMs?: number } = {}
): TimedReadable {
  const idleTimeoutMs = options.idleTimeoutMs ?? config.downloadIdleTimeout
  const sizeAwareTimeoutMs =
    Math.ceil(Number(fileSize) / config.downloadMinBytesPerSecond) * 1_000 + idleTimeoutMs

  return createTimedReadable(
    (signal) => ifs.cat(cid, { signal }),
    {
      idleTimeoutMs,
      totalTimeoutMs:
        options.totalTimeoutMs ??
        Math.min(2_147_483_647, Math.max(idleTimeoutMs, sizeAwareTimeoutMs))
    },
    () => new FileNotFoundError('Unable to retrieve the file. Request timed out.'),
    options.signal
  )
}
