import { PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import type { PingService } from '@libp2p/ping'
import { multiaddr, Multiaddr } from '@multiformats/multiaddr'
import { Request, Response, Router } from 'express'
import { PeerIdDto } from '../dto/peer-id.dto.js'
import { helia } from '../helia.js'
import { pino } from '../utils/logger.js'

const router = Router()

router.get(
  '/services/ping',
  async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
    try {
      const peerId = peerIdFromString(req.query.peerId || '')
      const pingService = helia.libp2p.services.ping as PingService
      const pong = await pingService.ping(peerId)

      res.send({
        pong
      })
    } catch (err) {
      res.send({
        error: err.message
      })
    }
  }
)

router.get('/peerStore', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
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
    res.send({
      error: err.message
    })
  }
})

router.get('/peerInfo', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
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
    res.send({
      error: err.message
    })
  }
})

router.get(
  '/dial',
  async (req: Request<never, never, never, PeerIdDto & { multiAddr: string }>, res: Response) => {
    let peerId: PeerId | undefined
    let multiAddr: Multiaddr | undefined
    try {
      if (req.query.peerId) {
        peerId = peerIdFromString(req.query.peerId || '')
      }

      if (req.query.multiAddr) {
        multiAddr = multiaddr(req.query.multiAddr || '')
      }
    } catch (err) {
      pino.logger.error('Invalid peer ID:' + err.message)
      res.send({
        success: false,
        error: 'Invalid peer ID'
      })
      return
    }

    if (multiAddr) {
      pino.logger.info(`Peering by multiAddress: ${multiAddr}`)
    } else if (peerId) {
      pino.logger.info(`Peering by PeerID: ${peerId}`)
    }

    try {
      const peer = multiAddr || peerId
      if (!peer) {
        throw new Error('Empty peerId and MultiAddr')
      }
      const connection = await helia.libp2p.dial(peer)
      res.send({ success: true, connection })
    } catch (err) {
      pino.logger.warn(`Cannot dial peer: ${err.message}`)

      res.send({
        success: false,
        error: err.message
      })
      pino.logger.error(err)
    }
  }
)

router.get('/connections', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
  try {
    const peerId = req.query.peerId?.toString() || ''
    const connections = helia.libp2p.getConnections(peerId ? peerIdFromString(peerId) : undefined)

    res.send({
      length: connections.length,
      connections
    })
  } catch (err) {
    pino.logger.error(err)
    res.status(400)
    res.send({
      error: err.message
    })
  }
})

router.get('/status', async (req, res) => {
  res.send({
    status: helia.libp2p.status
  })
})

router.get('/peers', (req, res) => {
  try {
    const peers = helia.libp2p.getPeers()

    res.send({ peers })
  } catch (err) {
    pino.logger.error(err)
    res.status(400)
    res.send({
      error: err.message
    })
  }
})

export default router
