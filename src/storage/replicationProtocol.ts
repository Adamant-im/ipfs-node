import type { Connection, Stream } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { PeerId } from '@libp2p/interface'
import { CID } from 'multiformats/cid'
import type { IpfsNode } from '../ipfs-node.js'
import { FileLifecycleBusyError } from './registry.js'

/**
 * Version of the replication wire format.
 *
 * Deliberately not the package version. It describes what two nodes have to
 * agree on to talk to each other, and that changes far less often than the
 * software does: taking it from `package.json` would break interoperability on
 * every release, for no reason.
 *
 * Raise it when the wire format changes in a way an older node cannot read —
 * a new required field, a different framing, or an operation whose meaning
 * changed. Adding an operation an older node simply never sends does not
 * require it.
 */
export const REPLICATION_PROTOCOL_VERSION = '1.0.0'

/**
 * Protocol nodes use to place copies of a file.
 *
 * It runs over libp2p rather than over the REST API on purpose. The libp2p
 * handshake already proves the remote peer id cryptographically, so no shared
 * secret has to be distributed, no second port has to be exposed, and no peer
 * has to publish an HTTP address for the others to reach it.
 */
export const REPLICATION_PROTOCOL = `/adamant/replication/${REPLICATION_PROTOCOL_VERSION}`

/**
 * Versions this node speaks, newest first.
 *
 * libp2p negotiates the first entry both ends support, so keeping an older
 * version in this list is what lets a network be upgraded one node at a time.
 * Until there is a second entry, an upgrade has to be applied everywhere.
 */
export const SUPPORTED_REPLICATION_PROTOCOLS = [REPLICATION_PROTOCOL]

/** Control messages are short; anything larger is a protocol violation. */
const MAX_MESSAGE_BYTES = 4096

export type ReplicationRequest =
  /** Store and pin `cid`, pulling the blocks from the requesting peer. */
  | { op: 'store'; cid: string }
  /** Prepare a pin that becomes permanent only after the upload commits. */
  | { op: 'stage'; cid: string; transactionId: string }
  /** Make a prepared copy permanent. */
  | { op: 'commit'; cid: string; transactionId: string }
  /** Withdraw one upload's claim on a prepared copy. */
  | { op: 'abort'; cid: string; transactionId: string }
  /** Report whether this node deliberately holds `cid`. */
  | { op: 'have'; cid: string }
  /** Report whether this node has room to take another copy. */
  | { op: 'accept'; cid: string }
  /**
   * Hold a copy without taking responsibility for it.
   *
   * Accepted from any peer, because it grants nothing a reader does not already
   * have: the blocks are unpinned, so they are reclaimed as soon as space is
   * short, exactly like content cached while answering a read. The DAG is
   * fetched through Bitswap from whichever connected peer has the blocks, not
   * only from the requester — the same path a public read uses.
   */
  | { op: 'cache'; cid: string }

export type ReplicationResponse =
  | { ok: true; op: 'store'; storedBytes: number }
  | { ok: true; op: 'stage'; storedBytes: number; staged: boolean }
  | { ok: true; op: 'commit' }
  | { ok: true; op: 'abort' }
  | { ok: true; op: 'have'; has: boolean }
  | { ok: true; op: 'accept'; willAccept: boolean }
  | { ok: true; op: 'cache'; cachedBytes: number }
  | { ok: false; error: string; code?: ReplicationErrorCode }

/** Why a replication request was refused, when the peer could name the reason. */
export type ReplicationErrorCode =
  'not_authorized' | 'busy' | 'not_staged' | 'already_aborted' | 'no_room' | 'invalid' | 'failed'

/** Structured refusal from {@link call}, so the client can tell busy from a lost ack. */
export class ReplicationProtocolError extends Error {
  constructor(
    message: string,
    readonly code: ReplicationErrorCode
  ) {
    super(message)
    this.name = 'ReplicationProtocolError'
  }
}

/**
 * Node behaviour behind the protocol.
 *
 * Injected rather than imported so that the wire format can be exercised
 * without a registry, a blockstore, or a running cron.
 */
export interface ReplicationHandlers {
  /**
   * Whether a peer may ask this node to spend disk on its behalf.
   *
   * Until file ownership is signed by the uploader, this is the only thing
   * standing between the node and an arbitrary peer filling its disk.
   */
  isAuthorized(peerId: string): boolean
  /** Pin `cid` and register it, returning the bytes now held for it. */
  store(cid: string): Promise<number>
  /** Prepare a rollback-capable copy for a strict upload. */
  stage(
    cid: string,
    transactionId: string,
    peerId: string
  ): Promise<{ storedBytes: number; staged: boolean }>
  /** Commit a prepared copy. */
  commit(cid: string, transactionId: string, peerId: string): Promise<void>
  /** Abort one transaction's claim on a prepared copy. */
  abort(cid: string, transactionId: string, peerId: string): Promise<void>
  /** Whether this node holds `cid` durably, not merely cached. */
  have(cid: string): Promise<boolean>
  /**
   * Whether this node has room for another copy.
   *
   * Asked before a transfer starts, so a node that is full costs one short
   * message instead of a whole file that it cannot keep.
   */
  willAccept(): Promise<boolean>
  /**
   * Pull `cid` into the local blockstore without pinning or registering it.
   *
   * Fetches via Bitswap, so blocks may come from any connected peer that has
   * them, not only from the caller. Bounded by the intake budget and disk
   * reserve. The copy sits in the same tier as read cache.
   */
  cacheCopy(cid: string, peerId: string): Promise<number>
  onError?(message: string): void
  /** Called when a peer asks for something it is not allowed to ask for. */
  onRefused?(peerId: string, op: string): void
}

/**
 * Flatten one stream chunk.
 *
 * The list type is described structurally rather than imported: libp2p resolves
 * its own copy of that package, and a second import would be a different
 * nominal type to TypeScript.
 */
function toBytes(chunk: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray()
}

/** Bytes of the length prefix that precedes every message. */
const LENGTH_PREFIX_BYTES = 4

/**
 * Frame one message with its length.
 *
 * The length is what tells the reader when a message is complete. Ending the
 * stream would work too, but only if the half-close reaches the other side
 * promptly, and when it does not both ends wait for each other until the call
 * times out.
 */
function encodeMessage(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength)

  new DataView(frame.buffer).setUint32(0, body.byteLength)
  frame.set(body, LENGTH_PREFIX_BYTES)

  return frame
}

/** Read exactly one framed message, without waiting for the stream to end. */
async function readMessage(stream: Stream, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted === true) {
    throw new Error('Replication message timed out')
  }

  const abort = (): void => stream.abort(new Error('Replication message timed out'))
  signal?.addEventListener('abort', abort, { once: true })

  try {
    const chunks: Uint8Array[] = []
    let received = 0

    for await (const chunk of stream) {
      const bytes = toBytes(chunk)
      chunks.push(bytes)
      received += bytes.byteLength

      if (received > MAX_MESSAGE_BYTES + LENGTH_PREFIX_BYTES) {
        throw new Error('Replication message is too large')
      }

      if (received < LENGTH_PREFIX_BYTES) {
        continue
      }

      const buffer = Buffer.concat(chunks)
      const length = buffer.readUInt32BE(0)

      if (length > MAX_MESSAGE_BYTES) {
        throw new Error('Replication message is too large')
      }

      if (buffer.byteLength >= LENGTH_PREFIX_BYTES + length) {
        return JSON.parse(
          buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length).toString('utf8')
        ) as unknown
      }
    }

    throw new Error('Replication stream ended before a complete message arrived')
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** Send one framed message. The stream stays open for the reply. */
function sendMessage(stream: Stream, message: unknown): void {
  stream.send(encodeMessage(message))
}

function parseRequest(value: unknown): ReplicationRequest {
  const message = value as Partial<ReplicationRequest>

  if (typeof message?.cid !== 'string' || message.cid === '') {
    throw new Error('Replication request is missing a CID')
  }

  try {
    CID.parse(message.cid)
  } catch {
    throw new Error('Replication request has an invalid CID')
  }

  const operations: ReplicationRequest['op'][] = [
    'store',
    'stage',
    'commit',
    'abort',
    'have',
    'accept',
    'cache'
  ]
  const op = operations.find((known) => known === message.op)

  if (op === undefined) {
    throw new Error('Unknown replication operation')
  }

  if (op === 'stage' || op === 'commit' || op === 'abort') {
    const transactionId = (value as { transactionId?: unknown }).transactionId

    if (typeof transactionId !== 'string' || transactionId.length === 0) {
      throw new Error('Replication request is missing a transaction id')
    }

    return { op, cid: message.cid, transactionId }
  }

  return { op, cid: message.cid }
}

function failureResponse(err: unknown): { ok: false; error: string; code: ReplicationErrorCode } {
  if (err instanceof FileLifecycleBusyError) {
    return { ok: false, error: 'File lifecycle is busy', code: 'busy' }
  }

  if (err instanceof ReplicationProtocolError) {
    return { ok: false, error: err.message, code: err.code }
  }

  const message = err instanceof Error ? err.message : 'Replication request failed'

  if (message.includes('Not authorized') || message.includes('staged by another peer')) {
    return { ok: false, error: 'Not authorized', code: 'not_authorized' }
  }

  if (message.includes('was already aborted')) {
    return { ok: false, error: message, code: 'already_aborted' }
  }

  if (
    message.includes('unrelated temporary') ||
    message.includes('unsettled local') ||
    message.includes('active lifecycle')
  ) {
    return { ok: false, error: message, code: 'busy' }
  }

  if (message.includes('is not staged')) {
    return { ok: false, error: message, code: 'not_staged' }
  }

  if (message.includes('no room') || message.includes('No room')) {
    return { ok: false, error: message, code: 'no_room' }
  }

  return { ok: false, error: 'Replication request failed', code: 'failed' }
}

async function respond(
  stream: Stream,
  connection: Connection,
  handlers: ReplicationHandlers,
  requestTimeoutMs: number
): Promise<void> {
  const request = parseRequest(await readMessage(stream, AbortSignal.timeout(requestTimeoutMs)))
  const peerId = connection.remotePeer.toString()

  try {
    // Holding an extra copy is open to anyone, because it costs no more than a
    // read from the same peer would. Everything that makes this node responsible
    // for content stays behind the authorization check. Open still means
    // accountable: the handler charges the request to the peer that made it.
    if (request.op === 'cache') {
      if (!(await handlers.willAccept())) {
        sendMessage(stream, { ok: false, error: 'No room for another copy', code: 'no_room' })
        return
      }

      const cachedBytes = await handlers.cacheCopy(request.cid, peerId)
      sendMessage(stream, { ok: true, op: 'cache', cachedBytes })
      return
    }

    if (!handlers.isAuthorized(peerId)) {
      handlers.onRefused?.(peerId, request.op)
      sendMessage(stream, { ok: false, error: 'Not authorized', code: 'not_authorized' })
      return
    }

    if (request.op === 'have') {
      sendMessage(stream, { ok: true, op: 'have', has: await handlers.have(request.cid) })
      return
    }

    if (request.op === 'accept') {
      sendMessage(stream, { ok: true, op: 'accept', willAccept: await handlers.willAccept() })
      return
    }

    if (request.op === 'stage') {
      const staged = await handlers.stage(request.cid, request.transactionId, peerId)
      sendMessage(stream, { ok: true, op: 'stage', ...staged })
      return
    }

    if (request.op === 'commit') {
      await handlers.commit(request.cid, request.transactionId, peerId)
      sendMessage(stream, { ok: true, op: 'commit' })
      return
    }

    if (request.op === 'abort') {
      await handlers.abort(request.cid, request.transactionId, peerId)
      sendMessage(stream, { ok: true, op: 'abort' })
      return
    }

    const storedBytes = await handlers.store(request.cid)
    sendMessage(stream, { ok: true, op: 'store', storedBytes })
  } catch (err) {
    sendMessage(stream, failureResponse(err))
  }
}

/** Start answering replication requests from other ADAMANT nodes. */
export async function registerReplicationProtocol(
  node: IpfsNode,
  handlers: ReplicationHandlers,
  options: { requestTimeoutMs?: number } = {}
): Promise<void> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000

  await node.libp2p.handle(SUPPORTED_REPLICATION_PROTOCOLS, (stream, connection) => {
    respond(stream, connection, handlers, requestTimeoutMs)
      .then(async () => stream.close())
      .catch((err: Error) => {
        handlers.onError?.(`Replication request failed: ${err.message}`)
        stream.abort(err)
      })
  })
}

export interface ReplicationCallOptions {
  /** Bounds the dial, the request, and the peer's own work on it. */
  timeoutMs: number
}

async function call(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  request: ReplicationRequest,
  options: ReplicationCallOptions
): Promise<ReplicationResponse> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  const stream = await node.libp2p.dialProtocol(peer, SUPPORTED_REPLICATION_PROTOCOLS, { signal })

  const abortStream = (): void => stream.abort(new Error('Replication request timed out'))
  signal.addEventListener('abort', abortStream, { once: true })

  try {
    sendMessage(stream, request)
    const response = (await readMessage(stream, signal)) as ReplicationResponse

    if (response?.ok !== true) {
      throw new ReplicationProtocolError(
        response?.error ?? 'Replication request was refused',
        response?.code ?? 'failed'
      )
    }

    return response
  } finally {
    signal.removeEventListener('abort', abortStream)
    await stream.close().catch(() => {})
  }
}

/**
 * Ask a peer to store a copy.
 *
 * The peer pulls the blocks over the connection this request arrived on, and
 * pins them before answering, so a successful call means the copy is durable
 * there and not merely queued.
 */
export async function requestStore(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  options: ReplicationCallOptions
): Promise<number> {
  const response = await call(node, peer, { op: 'store', cid }, options)
  return response.ok && response.op === 'store' ? response.storedBytes : 0
}

/** Prepare a rollback-capable copy for a strict upload. */
export async function requestStage(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  transactionId: string,
  options: ReplicationCallOptions
): Promise<{ storedBytes: number; staged: boolean }> {
  const response = await call(node, peer, { op: 'stage', cid, transactionId }, options)

  return response.ok && response.op === 'stage'
    ? { storedBytes: response.storedBytes, staged: response.staged }
    : { storedBytes: 0, staged: false }
}

/** Commit a copy prepared by {@link requestStage}. */
export async function requestCommit(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  transactionId: string,
  options: ReplicationCallOptions
): Promise<void> {
  const response = await call(node, peer, { op: 'commit', cid, transactionId }, options)

  if (!response.ok || response.op !== 'commit') {
    throw new Error('Unexpected replication commit response')
  }
}

/** Abort one transaction's claim on a prepared copy. */
export async function requestAbort(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  transactionId: string,
  options: ReplicationCallOptions
): Promise<void> {
  const response = await call(node, peer, { op: 'abort', cid, transactionId }, options)

  if (!response.ok || response.op !== 'abort') {
    throw new Error('Unexpected replication abort response')
  }
}

/**
 * Ask a peer whether it has room for another copy.
 *
 * A peer that answers no is skipped, which is the difference between one short
 * message and a whole file transferred to a node that will refuse it.
 */
export async function probeAccept(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  options: ReplicationCallOptions
): Promise<boolean> {
  const response = await call(node, peer, { op: 'accept', cid }, options)
  return response.ok && response.op === 'accept' ? response.willAccept : false
}

/**
 * Ask a peer to hold an extra copy it is not responsible for.
 *
 * Used when a peer will not accept a copy it has to keep, which is what happens
 * while this node is not in its configuration. The file still spreads and stays
 * readable from that peer; nobody promises to keep it there.
 */
export async function requestCache(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  options: ReplicationCallOptions
): Promise<number> {
  const response = await call(node, peer, { op: 'cache', cid }, options)
  return response.ok && response.op === 'cache' ? response.cachedBytes : 0
}

/** Ask a peer whether it still holds a file durably. */
export async function probeHave(
  node: IpfsNode,
  peer: PeerId | Multiaddr,
  cid: string,
  options: ReplicationCallOptions
): Promise<boolean> {
  const response = await call(node, peer, { op: 'have', cid }, options)
  return response.ok && response.op === 'have' ? response.has : false
}
