import type { NextFunction, Response } from 'express'
import type { Readable } from 'node:stream'

export type DownloadMetadata = {
  cid: string
  fileSize: bigint
}

/** Match a request validator against the strong CID ETag emitted by this node. */
export function matchesDownloadEtag(value: string | undefined, cid: string): boolean {
  if (value === undefined) return false
  const expected = `"${cid}"`
  return value
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === expected)
}

/** Apply the stable cache and content negotiation headers for a CID response. */
export function setDownloadHeaders(res: Response, metadata: DownloadMetadata): void {
  if (res.headersSent) return

  res.set('Content-Type', 'application/octet-stream')
  res.set('Content-Length', metadata.fileSize.toString())
  res.set('Content-Disposition', `attachment; filename="${metadata.cid}"`)
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('ETag', `"${metadata.cid}"`)
  // Files may be explicitly released, so shared immutable caching would outlive
  // the node's serving policy. Private caches revalidate after a bounded hour.
  res.set('Cache-Control', 'private, max-age=3600, must-revalidate')
  res.set('Accept-Ranges', 'none')
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
  const applyHeaders = (): void => setDownloadHeaders(res, metadata)

  stream.once('data', applyHeaders)
  stream.once('end', applyHeaders)
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
