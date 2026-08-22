import { Connection, PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, Multiaddr } from '@multiformats/multiaddr'
import { type NextFunction, Request, Response, Router } from 'express'
import { PeerIdDto } from '../dto/peer-id.dto.js'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'
import { InvalidRequestError } from '../security/errors.js'

const router = Router()

/**
 * Reduce a libp2p connection to a JSON-serialisable summary.
 *
 * libp2p `Connection` objects hold streams, loggers and multiaddr instances and
 * cannot be passed to `res.send()` directly — serialising one throws
 * "toJSON not set".
 */
function serializeConnection(connection: Connection) {
  return {
    id: connection.id,
    remotePeer: connection.remotePeer.toString(),
    remoteAddr: connection.remoteAddr.toString(),
    direction: connection.direction,
    status: connection.status,
    multiplexer: connection.multiplexer,
    encryption: connection.encryption,
    streams: connection.streams.length,
    timeline: connection.timeline
  }
}

router.get(
  '/services/ping',
  async (req: Request<never, never, never, PeerIdDto>, res: Response, next: NextFunction) => {
    try {
      const peerId = peerIdFromString(req.query.peerId || '')
      // Round-trip time in milliseconds; the `ping` service is registered in `createIpfsNode`
      const pong = await helia.libp2p.services.ping.ping(peerId)

      res.send({
        pong
      })
    } catch (err) {
      next(err)
    }
  }
)

router.get(
  '/peerStore',
  async (req: Request<never, never, never, PeerIdDto>, res: Response, next: NextFunction) => {
    const peerId = req.query.peerId

    try {
      const peers = await helia.libp2p.peerStore.all({
        filters: [
          (peer) => {
            if (!peerId) {
              return true
            }

            return peer.id.toString() === peerId
          }
        ],
        limit: 10
      })

      res.send({
        length: peers.length,
        peers: peers.map((peer) => {
          return {
            id: peer.id.toString()
          }
        })
      })
    } catch (err) {
      next(err)
    }
  }
)

router.get(
  '/peerInfo',
  async (req: Request<never, never, never, PeerIdDto>, res: Response, next: NextFunction) => {
    const peerId = req.query.peerId

    try {
      const peers = await helia.libp2p.peerStore.all({
        filters: [(peer) => peer.id.toString() === peerId],
        limit: 10
      })

      res.send({
        length: peers.length,
        peer: peers
      })
    } catch (err) {
      next(err)
    }
  }
)

router.get(
  '/dial',
  async (
    req: Request<never, never, never, PeerIdDto & { multiAddr: string }>,
    res: Response,
    next: NextFunction
  ) => {
    let peerId: PeerId | undefined
    let multiAddr: Multiaddr | undefined
    try {
      if (req.query.peerId) {
        peerId = peerIdFromString(req.query.peerId || '')
      }

      if (req.query.multiAddr) {
        multiAddr = multiaddr(req.query.multiAddr || '')
      }
    } catch {
      next(new InvalidRequestError('Invalid peer identifier or multiaddress'))
      return
    }

    if (multiAddr) {
      logger.info(`Peering by multiAddress: ${multiAddr}`)
    } else if (peerId) {
      logger.info(`Peering by PeerID: ${peerId}`)
    }

    const peer = multiAddr || peerId
    if (!peer) {
      next(new InvalidRequestError('Peer identifier or multiaddress is required'))
      return
    }

    try {
      const connection = await helia.libp2p.dial(peer)
      res.send({ success: true, connection: serializeConnection(connection) })
    } catch (err) {
      next(err)
    }
  }
)

router.get(
  '/connections',
  async (req: Request<never, never, never, PeerIdDto>, res: Response, next: NextFunction) => {
    try {
      const peerId = req.query.peerId?.toString() || ''
      const connections = helia.libp2p.getConnections(peerId ? peerIdFromString(peerId) : undefined)

      res.send({
        length: connections.length,
        connections: connections.map(serializeConnection)
      })
    } catch (err) {
      next(err)
    }
  }
)

router.get('/status', async (req, res, next) => {
  try {
    res.send({ status: helia.libp2p.status })
  } catch (err) {
    next(err)
  }
})

router.get('/peers', (req, res, next) => {
  try {
    const peers = helia.libp2p.getPeers()

    res.send({ peers })
  } catch (err) {
    next(err)
  }
})

export default router
