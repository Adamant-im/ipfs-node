import { CID } from 'multiformats/cid'
import { Readable } from 'node:stream'
import { clearTimeout } from 'node:timers'
import { config } from '../config.js'
import { ifs } from '../helia.js'
import { logger } from './logger.js'

/**
 * Return file statistics by CID.
 * Throws a timeout error if the file is not found.
 */
export async function getFileStats(cid: CID) {
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort(new Error('Cannot find requested CID. Request timed out.'))
  }, config.findFileTimeout)

  try {
    return await ifs.stat(cid, { signal: abortController.signal })
  } catch (err) {
    logger.debug(err)

    throw new FileNotFoundError('Cannot find requested CID. Request timed out.')
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Return a file stream by CID.
 * Throws a timeout error if the file is not found.
 */
export function downloadFile(cid: CID) {
  const abortController = new AbortController()

  let aborted = false
  const abort = () => {
    if (aborted) return

    aborted = true
    abortController.abort(new FileNotFoundError('Unable to retrieve the file. Request timed out.'))
  }
  const abortTimer = setTimeout(abort, config.findFileTimeout)

  const stream = Readable.from(
    ifs.cat(cid, {
      signal: abortController.signal
    })
  )
  stream.on('data', () => {
    clearTimeout(abortTimer)
  })
  stream.on('end', () => {
    clearTimeout(abortTimer)
  })
  stream.on('error', () => {
    clearTimeout(abortTimer)
  })

  return stream
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}
