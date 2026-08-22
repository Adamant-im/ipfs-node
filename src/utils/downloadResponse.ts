import type { NextFunction, Response } from 'express'
import type { Readable } from 'node:stream'

export type DownloadMetadata = {
  cid: string
  fileSize: bigint
}

/**
 * Pipe a file stream while preserving a controlled JSON error response before
 * the first byte and terminating an incomplete binary response afterwards.
 *
 * @param stream IPFS content stream
 * @param res Express response
 * @param metadata CID and expected byte length
 * @param next Express error callback for failures before streaming starts
 * @param onLateError logger callback for failures after response bytes start
 */
export function sendDownloadStream(
  stream: Readable,
  res: Response,
  metadata: DownloadMetadata,
  next: NextFunction,
  onLateError: (error: Error) => void
): void {
  const setDownloadHeaders = (): void => {
    if (res.headersSent) {
      return
    }

    res.set('Content-Type', 'application/octet-stream')
    res.set('Content-Length', metadata.fileSize.toString())
    res.set('Content-Disposition', `attachment; filename="${metadata.cid}"`)
    res.set('X-Content-Type-Options', 'nosniff')
  }

  stream.once('data', setDownloadHeaders)
  stream.once('end', setDownloadHeaders)
  stream.once('error', (error: Error) => {
    stream.unpipe(res)
    if (res.headersSent) {
      onLateError(error)
      res.destroy(error)
      return
    }
    next(error)
  })

  stream.pipe(res)
}
