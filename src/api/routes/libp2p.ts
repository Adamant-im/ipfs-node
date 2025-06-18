import { PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { Ping } from '@libp2p/ping'
import { multiaddr, Multiaddr } from '@multiformats/multiaddr'
import { Request, Response, Router } from 'express'

import { helia } from '../../services/helia/helia.js'
import { logger } from '../../utils/logger.js'
import { PeerIdDto } from '../dto/peer-id.dto.js'

const router = Router()

/**
 * @openapi
 * /api/libp2p/services/ping:
 *   get:
 *     tags: [Libp2p]
 *     summary: Ping a libp2p peer
 *     description: Sends a ping to the specified libp2p peer ID using the libp2p ping service. Returns the round-trip time in milliseconds.
 *     parameters:
 *       - in: query
 *         name: peerId
 *         required: true
 *         schema:
 *           type: string
 *         description: The libp2p peer ID to ping.
 *     responses:
 *       200:
 *         description: Ping successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pong:
 *                   type: number
 *                   format: float
 *                   description: Round-trip time in milliseconds.
 *             example:
 *               pong: 57.3
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get(
  '/services/ping',
  async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
    try {
      /**
       * TODO: This fails and needs an update
       * May be better use multiaddress?
       */
      const peerId = peerIdFromString(req.query.peerId || '')
      const pingService = helia.libp2p.services.ping as Ping
      const pong = await pingService.ping(peerId)

      res.send({
        pong
      })
    } catch (error) {
      // TODO: process NoValidAddressError
      logger.error(error)
      // Unable to determine error
      res.send({
        error: error.message
      })
    }
  }
)

/**
 * @openapi
 * /api/libp2p/peerStore:
 *   get:
 *     tags: [Libp2p]
 *     summary: Retrieve peers from the libp2p peer store
 *     description: Returns a list of known peers from the libp2p peer store. Optionally filter by a specific peer ID.
 *     parameters:
 *       - in: query
 *         name: peerId
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional peer ID to filter the peer store.
 *     responses:
 *       200:
 *         description: List of peers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 length:
 *                   type: integer
 *                   description: Number of peers returned.
 *                 peers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: The libp2p peer ID.
 *             example:
 *               length: 2
 *               peers:
 *                 - id: "QmPeerId1"
 *                 - id: "QmPeerId2"
 *       500:
 *         description: Failed to retrieve peers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
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
  } catch (error) {
    res.send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/libp2p/peerInfo:
 *   get:
 *     tags: [Libp2p]
 *     summary: Retrieve detailed info for a specific libp2p peer
 *     description: Returns detailed information for a specific libp2p peer by its peer ID.
 *     parameters:
 *       - in: query
 *         name: peerId
 *         required: true
 *         schema:
 *           type: string
 *         description: The libp2p peer ID to look up.
 *     responses:
 *       200:
 *         description: Peer information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 length:
 *                   type: integer
 *                   description: Number of peer records found (should be 0 or 1).
 *                 peer:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       addresses:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             multiaddr:
 *                               type: string
 *                             isCertified:
 *                               type: boolean
 *                       protocols:
 *                         type: array
 *                         items:
 *                           type: string
 *                       metadata:
 *                         type: object
 *                       tags:
 *                         type: object
 *                       peerRecordEnvelope:
 *                         type: object
 *                       id:
 *                         type: string
 *                         description: The peer ID.
 *                       multiaddrs:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Multiaddresses associated with the peer (if available).
 *             example:
 *               length: 1
 *               peer:
 *                 - addresses:
 *                   - multiaddr: "/ip4/127.0.0.1/tcp/4001"
 *                     isCertified: true
 *                   protocols:
 *                   - "//ip4/ping/1.0.0"
 *                   - "/ipfs/bitswap/1.2.0"
 *                   - "/ipfs/id/1.0.0"
 *                   - "/ipfs/ping/1.0.0"
 *                   metadata: {}
 *                   tags: {}
 *                   peerRecordEnvelope: {}
 *                   id: "12D3KooWGMp6SaKon2UKwJsDEf3chLAGRzsjdAfDGN9zcwt6ydqJ"
 *       500:
 *         description: Failed to retrieve peer info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/peerInfo', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
  try {
    const peerId = req.query.peerId

    const peers = await helia.libp2p.peerStore.all({
      filters: [(peer) => peer.id.toString() === peerId],
      limit: 10
    })

    res.send({
      length: peers.length,
      peer: peers
    })
  } catch (error) {
    logger.error(error)
    res.send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/libp2p/dial:
 *   get:
 *     tags: [Libp2p]
 *     summary: Dial a libp2p peer by peer ID or multiaddress
 *     description: Initiates a connection to a libp2p peer using either a peer ID or a multiaddress.
 *     parameters:
 *       - in: query
 *         name: peerId
 *         required: true
 *         schema:
 *           type: string
 *         description: The peer ID to dial.
 *       - in: query
 *         name: multiAddr
 *         required: true
 *         schema:
 *           type: string
 *         description: The multiaddress of the peer to dial.
 *     responses:
 *       200:
 *         description: Dial result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Whether the dial succeeded.
 *                 connection:
 *                   type: object
 *                   description: Connection details if successful.
 *                   nullable: true
 *                 error:
 *                   type: string
 *                   description: Error message if dial failed.
 *                   nullable: true
 *             example:
 *                   success: true
 *                   connection: {}
 *       400:
 *         description: Invalid peer ID or multiaddress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Invalid peer ID"
 *       500:
 *         description: Failed to dial
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
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
    } catch (error) {
      logger.error(error)
      res.status(400).send({
        success: false,
        error: 'Invalid peer ID'
      })
      return
    }

    if (multiAddr) {
      logger.info(`Peering by multiAddress: ${multiAddr}`)
    } else if (peerId) {
      logger.info(`Peering by PeerID: ${peerId}`)
    }

    try {
      const peer = multiAddr || peerId
      if (!peer) {
        throw new Error('Empty peerId and MultiAddr')
      }
      const connection = await helia.libp2p.dial(peer)
      res.send({ success: true, connection })
    } catch (error) {
      logger.error(error)

      res.send({
        success: false,
        error: error.message
      })
    }
  }
)

/**
 * @openapi
 * /api/libp2p/connections:
 *   get:
 *     tags: [Libp2p]
 *     summary: Get libp2p connections, optionally filtered by peer ID
 *     description: Retrieves active libp2p connections. If a peerId query parameter is provided, returns connections to that peer only.
 *     parameters:
 *       - in: query
 *         name: peerId
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional peer ID to filter connections.
 *     responses:
 *       200:
 *         description: List of connections retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 length:
 *                   type: integer
 *                   description: Number of connections returned.
 *                 connections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       remoteAddr:
 *                         type: string
 *                       direction:
 *                         type: string
 *                       timeline:
 *                         type: object
 *                         properties:
 *                           open:
 *                             type: number
 *                           upgraded:
 *                             type: number
 *                       multiplexer:
 *                         type: string
 *                       encription:
 *                         type: string
 *                       status:
 *                         type: string
 *                       transient:
 *                         type: boolean
 *                       tags:
 *                         type: array
 *                   description: Array of connection objects.
 *             example:
 *               length: 1
 *               connections:
 *                 - id: "b8wzqa1750008314517"
 *                   remoteAddr: "/ip4/75.119.138.235/tcp/4001/p2p/12D3KooWKavDi49t6qZFuPqMPeehxNqHdDdbqqdvVVv7YasEYppm"
 *                   remotePeer: "12D3KooWKavDi49t6qZFuPqMPeehxNqHdDdbqqdvVVv7YasEYppm"
 *                   direction: "outbound"
 *                   timeline:
 *                     open: 1750008314367
 *                     upgraded: 1750008314516
 *                   multiplexer: "/yamux/1.0.0"
 *                   encryption: "/noise"
 *                   status: "open"
 *                   transient: false
 *                   tags: []
 *       500:
 *         description: Failed to retrieve connections
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/connections', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
  try {
    const peerId = req.query.peerId?.toString() || ''
    const connections = helia.libp2p.getConnections(peerId ? peerIdFromString(peerId) : undefined)

    res.send({
      length: connections.length,
      connections
    })
  } catch (error) {
    logger.error(error)
    res.status(400).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/libp2p/status:
 *   get:
 *     tags: [Libp2p]
 *     summary: Get current status of the libp2p node
 *     description: Returns the current status of the libp2p instance.
 *     responses:
 *       200:
 *         description: Libp2p status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   description: Current status of the libp2p node.
 *             example:
 *               status: "started"
 *       500:
 *         description: Failed to retrieve status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/status', async (req, res) => {
  res.send({
    status: helia.libp2p.status
  })
})

/**
 * @openapi
 * /api/libp2p/peers:
 *   get:
 *     tags: [Libp2p]
 *     summary: Get a list of connected libp2p peers
 *     description: Retrieves the peer IDs of all currently connected libp2p peers.
 *     responses:
 *       200:
 *         description: List of connected peers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 peers:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of peer IDs currently connected.
 *             example:
 *               peers:
 *                 - "12D3KooWKavDi49t6qZFuPqMPeehxNqHdDdbqqdvVVv7YasEYppm"
 *                 - "12D3KooWXu8TtyGbfC6KSH82VXkEG2UVsy8vcz5Qk5aY8JDbAqfFo"
 *       500:
 *         description: Failed to retrieve peers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/peers', (req, res) => {
  try {
    const peers = helia.libp2p.getPeers()

    res.send({ peers })
  } catch (error) {
    logger.error(error)
    res.status(400).send({
      error: error.message
    })
  }
})

export default router
