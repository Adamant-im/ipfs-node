import type { Blockstore } from 'interface-blockstore'

/** How much of a transfer has arrived, readable while it is still running. */
export interface TransferProgress {
  bytes: number
}

/** The part of a blockstore UnixFS needs to read content. */
export type ReadableBlocks = Pick<Blockstore, 'get' | 'put' | 'has'>

/**
 * Largest block a transfer is assumed to bring in at once.
 *
 * A block is fetched and written whole before any of its bytes can be counted,
 * so a limit can only be noticed once it has already been passed.
 */
export const MAX_BLOCK_BYTES = 2 * 1024 ** 2

/**
 * Blocks an intake reads at a time.
 *
 * This is what makes the limit enforceable at all. Left to itself, the UnixFS
 * exporter requests every block of a DAG before any of them completes — a
 * 64 MiB file issues 65 reads up front — so by the time the first byte can be
 * counted the whole DAG has already arrived, whatever the limit said. Measured
 * against a real node: with the reads unbounded a 64 MiB file lands in full
 * under a 4 MiB limit; at four at a time it stops at 4 MiB.
 *
 * It is not 1 because this is also the path an upload's copies take, and
 * serialising every block would put a round trip between each of them.
 */
export const INTAKE_READ_CONCURRENCY = 4

/**
 * Most a transfer can exceed its limit by.
 *
 * The reads already in flight when the limit is crossed still complete, so the
 * overshoot is bounded by them. Callers reserve this much headroom on top of
 * what they allow, so the excess is covered rather than merely small.
 */
export const INTAKE_OVERSHOOT_BYTES = INTAKE_READ_CONCURRENCY * MAX_BLOCK_BYTES

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
 * The limit is noticed late, because a block is stored before it can be counted
 * and several are read at a time. What arrives is bounded by `limitBytes` plus
 * {@link INTAKE_OVERSHOOT_BYTES}, which callers reserve as headroom — and only
 * while the reader honours {@link INTAKE_READ_CONCURRENCY}.
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
            // The block was fetched and stored whole before any of it could be
            // counted, so the rest of it is accounted for before giving up.
            // Charging only the part that was read would leave the budget
            // below what the peer actually spent.
            for await (const rest of block) {
              progress.bytes += rest.byteLength
            }

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
