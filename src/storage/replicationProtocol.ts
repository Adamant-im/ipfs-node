import type { Connection, Stream } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { PeerId } from '@libp2p/interface'
import type { IpfsNode } from '../ipfs-node.js'

/**
 * Protocol ADAMANT nodes use to place copies of a file.
 *
 * It runs over libp2p rather than over the REST API on purpose. The libp2p
 * handshake already proves the remote peer id cryptographically, so no shared
 * secret has to be distributed, no second port has to be exposed, and no peer
 * has to publish an HTTP address for the others to reach it.
 */
export const REPLICATION_PROTOCOL = '/adamant/replication/1.0.0'

/** Requests are two short fields; anything larger is a protocol violation. */
const MAX_MESSAGE_BYTES = 4096

export type ReplicationRequest =
  /** Store and pin `cid`, pulling the blocks from the requesting peer. */
  | { op: 'store'; cid: string }
  /** Report whether this node deliberately holds `cid`. */
  | { op: 'have'; cid: string }
  /** Report whether this node has room to take another copy. */
  | { op: 'accept'; cid: string }
  /**
   * Hold a copy without taking responsibility for it.
   *
   * Accepted from any peer, because it grants nothing a reader does not already
   * have: the blocks are unpinned, so they are reclaimed as soon as space is
   * short, exactly like content cached while answering a read.
   */
  | { op: 'cache'; cid: string }

export type ReplicationResponse =
  | { ok: true; op: 'store'; storedBytes: number }
  | { ok: true; op: 'have'; has: boolean }
  | { ok: true; op: 'accept'; willAccept: boolean }
  | { ok: true; op: 'cache'; cachedBytes: number }
  | { ok: false; error: string }

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
   * The node can serve the file from now on, and gives up nothing: the blocks
   * live in the same tier as read cache and go when space is needed.
   */
  cacheCopy(cid: string): Promise<number>
  onError?(message: string): void
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

/**
 * Read one message, which ends when the remote closes its writing end.
 *
 * Each stream carries exactly one request and one reply, so end-of-stream is
 * the frame delimiter and no length prefix is needed.
 */
async function readMessage(stream: Stream): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of stream) {
    const bytes = toBytes(chunk)
    total += bytes.byteLength

    if (total > MAX_MESSAGE_BYTES) {
      throw new Error('Replication message is too large')
    }

    chunks.push(bytes)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Send one message and close this end for writing. */
async function sendMessage(stream: Stream, message: unknown): Promise<void> {
  stream.send(new TextEncoder().encode(JSON.stringify(message)))
  await stream.close()
}

function parseRequest(value: unknown): ReplicationRequest {
  const message = value as Partial<ReplicationRequest>

  if (typeof message?.cid !== 'string' || message.cid === '') {
    throw new Error('Replication request is missing a CID')
  }

  const operations: ReplicationRequest['op'][] = ['store', 'have', 'accept', 'cache']
  const op = operations.find((known) => known === message.op)

  if (op === undefined) {
    throw new Error('Unknown replication operation')
  }

  return { op, cid: message.cid }
}

async function respond(
  stream: Stream,
  connection: Connection,
  handlers: ReplicationHandlers
): Promise<void> {
  const request = parseRequest(await readMessage(stream))

  // Holding an extra copy is open to anyone, because it costs no more than a
  // read from the same peer would. Everything that makes this node responsible
  // for content stays behind the authorization check.
  if (request.op === 'cache') {
    if (!(await handlers.willAccept())) {
      await sendMessage(stream, { ok: false, error: 'No room for another copy' })
      return
    }

    await sendMessage(stream, {
      ok: true,
      op: 'cache',
      cachedBytes: await handlers.cacheCopy(request.cid)
    })
    return
  }

  if (!handlers.isAuthorized(connection.remotePeer.toString())) {
    await sendMessage(stream, { ok: false, error: 'Not authorized' })
    return
  }

  if (request.op === 'have') {
    await sendMessage(stream, { ok: true, op: 'have', has: await handlers.have(request.cid) })
    return
  }

  if (request.op === 'accept') {
    await sendMessage(stream, {
      ok: true,
      op: 'accept',
      willAccept: await handlers.willAccept()
    })
    return
  }

  const storedBytes = await handlers.store(request.cid)
  await sendMessage(stream, { ok: true, op: 'store', storedBytes })
}

/** Start answering replication requests from other ADAMANT nodes. */
export async function registerReplicationProtocol(
  node: IpfsNode,
  handlers: ReplicationHandlers
): Promise<void> {
  await node.libp2p.handle(REPLICATION_PROTOCOL, (stream, connection) => {
    respond(stream, connection, handlers).catch((err: Error) => {
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
  const stream = await node.libp2p.dialProtocol(peer, REPLICATION_PROTOCOL, { signal })

  const abortStream = (): void => stream.abort(new Error('Replication request timed out'))
  signal.addEventListener('abort', abortStream, { once: true })

  try {
    await sendMessage(stream, request)
    const response = (await readMessage(stream)) as ReplicationResponse

    if (response?.ok !== true) {
      throw new Error(response?.error ?? 'Replication request was refused')
    }

    return response
  } finally {
    signal.removeEventListener('abort', abortStream)
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
