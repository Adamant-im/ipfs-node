import { withBitswap } from '@helia/bitswap'
import { withLibp2pLight, type HeliaWithLibp2p } from '@helia/libp2p'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from '@libp2p/bootstrap'
import { identify, type Identify } from '@libp2p/identify'
import { ping, type Ping } from '@libp2p/ping'
import { tcp } from '@libp2p/tcp'
import { createHeliaLight } from 'helia'
import type { Blockstore } from 'interface-blockstore'
import type { Datastore } from 'interface-datastore'
import type { ComponentLogger } from '@libp2p/interface'

/**
 * libp2p services this node registers.
 *
 * The set is deliberately minimal: ADAMANT nodes form a private mesh of known
 * peers, so content routing (DHT), NAT traversal and relay services provided by
 * the Helia defaults are neither needed nor wanted here.
 *
 * - `identify` lets peers exchange supported protocols and observed addresses
 * - `ping` backs `GET /api/libp2p/services/ping`
 */
export interface IpfsNodeServices extends Record<string, unknown> {
  identify: Identify
  ping: Ping
}

export type IpfsNode = HeliaWithLibp2p<IpfsNodeServices>

export interface IpfsNodeOptions {
  blockstore: Blockstore
  datastore: Datastore
  /** Multiaddrs to listen on. */
  listen: string[]
  /** Multiaddrs dialled on startup. An empty list disables bootstrap discovery. */
  bootstrap?: string[]
  /** Multiaddrs always allowed to connect, even past `maxConnections`. */
  allow?: string[]
  maxConnections?: number
  logger?: ComponentLogger
}

/** Default connection ceiling, kept from the pre-migration configuration. */
export const DEFAULT_MAX_CONNECTIONS = 100

/**
 * Create a Helia node configured for the ADAMANT topology.
 *
 * The node is composed explicitly out of `createHeliaLight`, `withLibp2pLight`
 * and `withBitswap` rather than `createHelia`. `createHelia` merges the Helia
 * default libp2p configuration (mDNS, the public IPFS bootstrap list, kad-DHT,
 * AutoNAT, AutoTLS, UPnP, circuit relay and WebRTC/WebSocket transports) into
 * whatever is passed in, which would silently widen the peer topology. The
 * light constructors apply exactly the configuration given here.
 *
 * Bitswap is kept because it is how known peers exchange blocks. HTTP gateway
 * routing is not registered, so block requests never leave the ADAMANT peer set.
 *
 * The node is returned started. The libp2p private key is loaded from — or
 * created in — `datastore` under `/pkcs8/self`, which keeps the peer identity
 * stable across restarts.
 */
export async function createIpfsNode(options: IpfsNodeOptions): Promise<IpfsNode> {
  const { blockstore, datastore, listen, logger } = options
  const bootstrapList = options.bootstrap ?? []

  const peerDiscovery: Array<ReturnType<typeof bootstrap>> = []
  // `bootstrap()` throws on an empty list, so only register it when there is one
  if (bootstrapList.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapList }))
  }

  const node = withBitswap(
    withLibp2pLight<ReturnType<typeof createHeliaLight>, IpfsNodeServices>(
      createHeliaLight({ blockstore, datastore, logger }),
      {
        addresses: { listen },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery,
        services: {
          identify: identify(),
          ping: ping()
        },
        connectionManager: {
          maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          allow: options.allow ?? []
        },
        logger
      }
    )
  )

  await node.start()

  return node
}

/**
 * Create the UnixFS interface used to add and read files.
 *
 * @param node A node returned by {@link createIpfsNode}
 */
export function createUnixFs(node: IpfsNode): UnixFS {
  return unixfs(node)
}
