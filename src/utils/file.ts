import { CID } from 'multiformats/cid'
import { Readable } from 'node:stream'
import { clearTimeout } from 'node:timers'
import { config } from '../config.js'
import { ifs } from '../helia.js'

/**
 * Return file statistics by CID.
 * Throws a timeout error if the file is not found.
 */
export async function getFileStats(cid: CID) {
  let timeout: NodeJS.Timeout | undefined
  try {
    const abortController = new AbortController()
    timeout = setTimeout(() => {
      abortController.abort(new Error('Cannot find requested CID. Request timed out.'))
    }, config.findFileTimeout)

    const stats = await ifs.stat(cid, { signal: abortController.signal })
    return stats
  } catch (err) {
    console.log(err)
    clearTimeout(timeout)

    throw new FileNotFoundError('Cannot find requested CID. Request timed out.')
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

  return stream
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}
