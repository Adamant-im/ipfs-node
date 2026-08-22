import { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'

/** Consume an async iterable for its side effects. */
async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const item of source) {
    void item
  }
}

/**
 * Pin a DAG so that garbage collection cannot reclaim it.
 *
 * Idempotent: pinning content that already carries a direct pin is reported as
 * `false` instead of failing, because Helia rejects a duplicate pin.
 *
 * @param signal Bounds the DAG walk, which fetches missing blocks from peers
 * @returns True when this call created the pin
 */
export async function pinFile(node: IpfsNode, cid: CID, signal?: AbortSignal): Promise<boolean> {
  try {
    // Draining the generator is what performs the DAG walk.
    await drain(node.pins.add(cid, { signal }))
    return true
  } catch (err) {
    if ((err as Error).name === 'AlreadyPinnedError') {
      return false
    }
    throw err
  }
}

/**
 * Remove the direct pin of a DAG, making it reclaimable.
 *
 * Idempotent: content without a direct pin is reported as `false`.
 */
export async function unpinFile(node: IpfsNode, cid: CID): Promise<boolean> {
  try {
    // Draining the generator is what performs the DAG walk.
    await drain(node.pins.rm(cid))
    return true
  } catch (err) {
    if ((err as Error).name === 'NotFoundError') {
      return false
    }
    throw err
  }
}

/**
 * True when garbage collection will keep the content.
 *
 * This is the predicate Helia applies while collecting, so it answers the only
 * question that matters for a protection check: direct and indirect pins both
 * count.
 */
export async function isProtected(node: IpfsNode, cid: CID): Promise<boolean> {
  return node.pins.isPinned(cid)
}

/**
 * True when the CID carries a direct pin, as opposed to an indirect one.
 *
 * `pins.get` is used rather than `pins.ls({ cid })`: listing filters by a
 * datastore key prefix, and `datastore-fs` reads a prefix as a directory glob,
 * so the lookup returns nothing for a pinned CID on a file-backed node.
 */
export async function isDirectlyPinned(node: IpfsNode, cid: CID): Promise<boolean> {
  try {
    await node.pins.get(cid)
    return true
  } catch (err) {
    if ((err as Error).name === 'NotFoundError') {
      return false
    }
    throw err
  }
}

/** Normalise a CID string for registry keys and pin lookups. */
export function parseRecordCid(cid: string): CID {
  return CID.parse(cid)
}
