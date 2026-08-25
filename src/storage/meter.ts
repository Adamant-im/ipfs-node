import type { Blockstore } from 'interface-blockstore'

/** How much of a transfer has arrived, readable while it is still running. */
export interface TransferProgress {
  bytes: number
}

/** The part of a blockstore UnixFS needs to read content. */
export type ReadableBlocks = Pick<Blockstore, 'get' | 'put' | 'has'>

/**
 * A blockstore view that charges every block read through it and stops at a
 * limit.
 *
 * Counting what a UnixFS stream yields measures the file's logical content, not
 * what crossed the network: DAG-PB nodes, links and other structural blocks are
 * fetched and written to the blockstore without appearing in the stream at all.
 * A DAG can be built whose logical content is empty while its structure is
 * megabytes, and a cap counting only the stream would read zero for it.
 *
 * Metering therefore sits under UnixFS rather than over it. The limit is
 * enforced per block as the walk proceeds, so an oversized DAG is abandoned
 * partway instead of after all of it has arrived.
 *
 * Blocks already on disk are counted too. That charges a little more than the
 * transfer really cost, which is the safe direction for a limit.
 *
 * @param progress Updated as blocks are consumed; survives a failed transfer,
 *   because a peer that sends almost everything and then aborts has spent the
 *   bandwidth either way
 * @param limitBytes Most this view may hand out before it refuses to continue
 */
export function meteredBlocks(
  source: ReadableBlocks,
  progress: TransferProgress,
  limitBytes: number
): ReadableBlocks {
  return {
    get: (cid, options) => {
      const block = source.get(cid, options)

      return (async function* () {
        for await (const chunk of block) {
          progress.bytes += chunk.byteLength

          if (progress.bytes > limitBytes) {
            throw new Error('Copy is larger than this node accepts')
          }

          yield chunk
        }
      })()
    },
    put: (cid, block, options) => source.put(cid, block, options),
    has: (cid, options) => source.has(cid, options)
  }
}
