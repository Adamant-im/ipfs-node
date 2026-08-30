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
 * @param onDisconnect cancels the underlying retrieval when the client leaves
 */
export function sendDownloadStream(
  stream: Readable,
  res: Response,
  metadata: DownloadMetadata,
  next: NextFunction,
  onLateError: (error: Error) => void,
  onDisconnect: () => void = () => undefined
): void {
  let clientDisconnected = false
  const setDownloadHeaders = (): void => {
    if (res.headersSent) {
      return
    }

    res.set('Content-Type', 'application/octet-stream')
    res.set('Content-Length', metadata.fileSize.toString())
    res.set('Content-Disposition', `attachment; filename="${metadata.cid}"`)
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('ETag', `"${metadata.cid}"`)
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('Accept-Ranges', 'none')
  }

  stream.once('data', setDownloadHeaders)
  stream.once('end', setDownloadHeaders)
  stream.once('error', (error: Error) => {
    stream.unpipe(res)
    if (clientDisconnected) {
      return
    }
    if (res.headersSent) {
      onLateError(error)
      res.destroy(error)
      return
    }
    next(error)
  })

  res.once('close', () => {
    if (res.writableEnded) return
    clientDisconnected = true
    onDisconnect()
    stream.destroy(new Error('Download client disconnected'))
  })

  stream.pipe(res)
}
