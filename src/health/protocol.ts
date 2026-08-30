import type { Connection, Stream } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { IpfsNode } from '../ipfs-node.js'

export const HEALTH_PROTOCOL_VERSION = '1.0.0'
export const HEALTH_PROTOCOL = `/adamant/health/${HEALTH_PROTOCOL_VERSION}`

const MAX_MESSAGE_BYTES = 1024
const LENGTH_PREFIX_BYTES = 4

export interface Attestation {
  round: number
  timestamp: number
  membershipVersion: string
}

function encode(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength)
  frame.set(body, LENGTH_PREFIX_BYTES)
  return frame
}

function send(stream: Stream, message: unknown): void {
  stream.send(encode(message))
}

async function read(stream: Stream, signal: AbortSignal): Promise<unknown> {
  const abort = (): void => stream.abort(new Error('Health attestation timed out'))
  signal.addEventListener('abort', abort, { once: true })

  try {
    const chunks: Uint8Array[] = []
    let received = 0

    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray()
      chunks.push(bytes)
      received += bytes.byteLength

      if (received > MAX_MESSAGE_BYTES + LENGTH_PREFIX_BYTES) {
        throw new Error('Health attestation is too large')
      }
      if (received < LENGTH_PREFIX_BYTES) continue

      const buffer = Buffer.concat(chunks)
      const length = buffer.readUInt32BE(0)
      if (length > MAX_MESSAGE_BYTES) throw new Error('Health attestation is too large')
      if (buffer.byteLength >= LENGTH_PREFIX_BYTES + length) {
        return JSON.parse(
          buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length).toString('utf8')
        ) as unknown
      }
    }

    throw new Error('Health stream ended before a complete message arrived')
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function parse(value: unknown): Attestation {
  const message = value as Partial<Attestation>
  if (
    !Number.isSafeInteger(message.round) ||
    !Number.isSafeInteger(message.timestamp) ||
    typeof message.membershipVersion !== 'string' ||
    message.membershipVersion.length !== 64
  ) {
    throw new Error('Invalid health attestation')
  }
  return message as Attestation
}

export interface HealthProtocolOptions {
  timeoutMs: number
  checkpointIntervalMs: number
  clockSkewToleranceMs: number
  membershipVersion: string
  authorizedPeerIds: Set<string>
  now?: () => number
  onError?: (message: string) => void
}

/**
 * Register the authenticated peer-to-peer checkpoint protocol.
 *
 * Authorization uses the peer id proven by the libp2p connection; no HTTP
 * secret is shared and an unconfigured peer cannot contribute to readiness.
 */
export async function registerHealthProtocol(
  node: IpfsNode,
  options: HealthProtocolOptions
): Promise<void> {
  const now = options.now ?? Date.now

  await node.libp2p.handle(HEALTH_PROTOCOL, (stream, connection: Connection) => {
    const handle = async (): Promise<void> => {
      if (!options.authorizedPeerIds.has(connection.remotePeer.toString())) {
        throw new Error('Health attestation peer is not authorized')
      }

      const request = parse(await read(stream, AbortSignal.timeout(options.timeoutMs)))
      const timestamp = now()
      const localRound =
        Math.floor(timestamp / options.checkpointIntervalMs) * options.checkpointIntervalMs

      if (
        request.membershipVersion !== options.membershipVersion ||
        request.round !== localRound ||
        Math.abs(timestamp - request.timestamp) > options.clockSkewToleranceMs
      ) {
        throw new Error('Health attestation does not match the local round')
      }

      send(stream, {
        round: localRound,
        timestamp,
        membershipVersion: options.membershipVersion
      })
    }

    handle()
      .then(async () => stream.close())
      .catch((err: Error) => {
        options.onError?.(err.message)
        stream.abort(err)
      })
  })
}

/** Ask one configured peer to attest the same fixed checkpoint round. */
export async function requestHealthAttestation(
  node: IpfsNode,
  peer: Multiaddr,
  request: Attestation,
  options: Pick<HealthProtocolOptions, 'timeoutMs' | 'clockSkewToleranceMs'>
): Promise<void> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  const stream = await node.libp2p.dialProtocol(peer, HEALTH_PROTOCOL, { signal })
  const abort = (): void => stream.abort(new Error('Health attestation timed out'))
  signal.addEventListener('abort', abort, { once: true })

  try {
    send(stream, request)
    const response = parse(await read(stream, signal))
    if (
      response.round !== request.round ||
      response.membershipVersion !== request.membershipVersion ||
      Math.abs(response.timestamp - request.timestamp) > options.clockSkewToleranceMs
    ) {
      throw new Error('Peer attested a different health round')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await stream.close().catch(() => {})
  }
}
