import type { Blockstore } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'
import { RequestSizeBudget } from './limits.js'

type Blocks = Blockstore

/**
 * Blocks that in-flight uploads are currently writing, counted per CID.
 *
 * Two requests may import identical content at the same time. Without this
 * counter a failing request would delete blocks a concurrent request still
 * depends on, so cleanup only touches CIDs no other session references.
 */
const inFlightBlocks = new Map<string, number>()

function retainBlock(cid: string): void {
  inFlightBlocks.set(cid, (inFlightBlocks.get(cid) ?? 0) + 1)
}

function releaseBlock(cid: string): number {
  const next = (inFlightBlocks.get(cid) ?? 1) - 1

  if (next <= 0) {
    inFlightBlocks.delete(cid)
    return 0
  }

  inFlightBlocks.set(cid, next)
  return next
}

/** Number of CIDs in-flight uploads currently hold. Exposed for diagnostics. */
export function inFlightBlockCount(): number {
  return inFlightBlocks.size
}

/** True when another in-flight upload still references this block. */
export function isBlockInFlight(cid: string): boolean {
  return inFlightBlocks.has(cid)
}

type PutOptions = Parameters<Blocks['put']>[2]
type GetOptions = Parameters<Blocks['get']>[1]
type HasOptions = Parameters<Blocks['has']>[1]
type BlockValue = Parameters<Blocks['put']>[1]

/**
 * Blockstore facade that remembers which blocks an upload actually created.
 *
 * Blocks that already existed are not recorded: they belong to previously
 * stored content and must survive the failure of the current upload.
 */
class RecordingBlockstore implements Pick<Blocks, 'get' | 'put' | 'has'> {
  /** CIDs this session wrote for the first time. */
  readonly created = new Set<string>()
  /** CIDs this session wrote, including duplicates of existing blocks. */
  private readonly touched = new Set<string>()
  bytesWritten = 0

  constructor(private readonly base: Blocks) {}

  async put(cid: CID, block: BlockValue, options?: PutOptions): Promise<CID> {
    const key = cid.toString()
    const existed = await this.base.has(cid, options)

    if (!this.touched.has(key)) {
      this.touched.add(key)
      retainBlock(key)
    }

    const result = await this.base.put(cid, block, options)

    if (!existed && !this.created.has(key)) {
      this.created.add(key)
      // The UnixFS importer always persists a whole block as one `Uint8Array`.
      // A streamed value carries no length to account for without consuming it,
      // so it is recorded for cleanup but contributes nothing to the estimate.
      this.bytesWritten += block instanceof Uint8Array ? block.byteLength : 0
    }

    return result
  }

  get(cid: CID, options?: GetOptions): ReturnType<Blocks['get']> {
    return this.base.get(cid, options)
  }

  async has(cid: CID, options?: HasOptions): Promise<boolean> {
    return this.base.has(cid, options)
  }

  /**
   * Create a facade that also counts the unique DAG blocks of one file.
   *
   * The ordinary session counter only measures newly written bytes. This
   * facade counts blocks even when they were already present, which is the
   * amount the resulting pin protects and the collector must account for.
   */
  beginFile(): {
    blockstore: Pick<Blocks, 'get' | 'put' | 'has'>
    readonly storedBytes: number
    readonly protectedBytes: number
  } {
    const before = this.bytesWritten
    const referenced = new Set<string>()
    let protectedBytes = 0
    const storedBytes = (): number => this.bytesWritten - before

    return {
      blockstore: {
        get: (cid, options) => this.get(cid, options),
        has: (cid, options) => this.has(cid, options),
        put: async (cid, block, options) => {
          const result = await this.put(cid, block, options)
          const key = cid.toString()

          if (!referenced.has(key)) {
            referenced.add(key)
            // The UnixFS importer supplies complete blocks as Uint8Arrays.
            // A streamed value cannot be measured without consuming it.
            protectedBytes += block instanceof Uint8Array ? block.byteLength : 0
          }

          return result
        }
      },
      get storedBytes() {
        return storedBytes()
      },
      get protectedBytes() {
        return protectedBytes
      }
    }
  }

  /** Drop the in-flight references taken by `put`. */
  releaseAll(): string[] {
    const zeroed: string[] = []

    for (const key of this.touched) {
      if (releaseBlock(key) === 0) {
        zeroed.push(key)
      }
    }

    this.touched.clear()
    return zeroed
  }
}

export interface UploadSessionOptions {
  /**
   * Blockstore the upload writes through.
   *
   * The Helia facade belongs here: it announces new blocks to connected peers
   * and takes the collection lock while writing.
   */
  blockstore: Blockstore
  /** Decides whether a block is protected from removal. */
  isPinned: (cid: CID) => Promise<boolean>
  /**
   * Removes a block this session created.
   *
   * This is deliberately not the Helia blockstore facade: its `delete` cancels
   * a reprovide first, which fails outright on a node that registers no content
   * routers, so cleanup addresses the store that actually holds the block.
   */
  deleteBlock: (cid: CID) => Promise<void>
  maxRequestSizeBytes: number
  parseCid: (cid: string) => CID
  onCleanupError?: (err: Error) => void
  /** Releases the shared storage-operation lease after commit or cleanup. */
  onSettle?: () => void
}

/**
 * Tracks everything a single upload request writes so that a rejected,
 * aborted or partially failed request leaves no blocks behind.
 *
 * The session is committed only after every file has been registered and
 * pinned. Any other outcome, including a client disconnect, ends in cleanup.
 */
export class UploadSession {
  readonly budget: RequestSizeBudget
  readonly blockstore: RecordingBlockstore
  private settled = false
  /**
   * True after the route handler has taken the session over.
   *
   * A client disconnect must not delete blocks the handler is pinning. The
   * handler's own `catch` still calls {@link cleanup} if the request fails.
   */
  private claimed = false

  constructor(private readonly options: UploadSessionOptions) {
    this.budget = new RequestSizeBudget(options.maxRequestSizeBytes)
    this.blockstore = new RecordingBlockstore(options.blockstore)
  }

  get bytesWritten(): number {
    return this.blockstore.bytesWritten
  }

  get isSettled(): boolean {
    return this.settled
  }

  get isClaimed(): boolean {
    return this.claimed
  }

  /**
   * Take ownership so a disconnect cannot race the pin/register path.
   *
   * @returns False when cleanup or commit already ran
   */
  claim(): boolean {
    if (this.settled) {
      return false
    }

    this.claimed = true
    return true
  }

  /**
   * Start accounting for a single part.
   *
   * Parts of a multipart request are imported one after another, so the delta
   * of the session counter is the number of new bytes this part contributed.
   */
  beginFile(): {
    blockstore: Pick<Blocks, 'get' | 'put' | 'has'>
    readonly storedBytes: number
    readonly protectedBytes: number
  } {
    return this.blockstore.beginFile()
  }

  /** Keep everything this session wrote. Called once the upload is durable. */
  commit(): void {
    if (this.settled) {
      return
    }

    this.settled = true
    this.claimed = false
    try {
      this.blockstore.releaseAll()
    } finally {
      this.options.onSettle?.()
    }
  }

  /**
   * Disconnect-path cleanup. No-ops once the handler has claimed the session.
   *
   * The checks are synchronous so they cannot interleave with {@link claim}.
   */
  async cleanupIfUnclaimed(): Promise<number> {
    if (this.settled || this.claimed) {
      return 0
    }

    return this.cleanup()
  }

  /**
   * Remove the blocks this session created.
   *
   * A block is deleted only when no other in-flight upload references it and it
   * is not pinned, so content that became durable in the meantime is never
   * touched. Whatever survives this pass is unpinned and therefore reclaimable
   * by the next garbage collection.
   *
   * @returns Number of blocks removed
   */
  async cleanup(): Promise<number> {
    if (this.settled) {
      return 0
    }

    this.settled = true
    this.claimed = false
    try {
      const releasable = new Set(this.blockstore.releaseAll())
      let removed = 0

      for (const key of this.blockstore.created) {
        if (!releasable.has(key)) {
          continue
        }

        try {
          const cid = this.options.parseCid(key)

          if (await this.options.isPinned(cid)) {
            continue
          }

          // Re-check at delete time: a concurrent upload may have retained the
          // block after `releaseAll` took the snapshot.
          if (isBlockInFlight(key)) {
            continue
          }

          await this.options.deleteBlock(cid)
          removed += 1
        } catch (err) {
          this.options.onCleanupError?.(err as Error)
        }
      }

      return removed
    } finally {
      this.options.onSettle?.()
    }
  }
}
