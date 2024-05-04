import { unixfs } from '@helia/unixfs'
import { peerIdFromString } from '@libp2p/peer-id'
import { CID } from 'multiformats/cid'
import express from 'express'
import multer, { Multer } from 'multer'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { autoPeeringHandler, autoPeering } from './cron.js'
import { helia } from './helia.js'
import { Pin } from 'helia'
import { flatFiles } from './utils/utils.js'
import { Request, Response } from 'express'
import { PeerIdDto } from './dto/peer-id.dto.js'
import { createVerifiedFetch } from '@helia/verified-fetch'
import { pino } from './utils/logger.js'
import type { PingService } from '@libp2p/ping'
import { KadDHT } from '@libp2p/kad-dht'
import { PeerId } from '@libp2p/interface'
import config, { configFileName } from './config.js'
import { Writable } from 'node:stream'

pino.logger.info(`Using config file: ${configFileName}`)

const verifiedFetch = await createVerifiedFetch(helia)
const upload = multer({ limits: { fileSize: config.uploadLimitSizeBytes } })

let logNewPeers = false

helia.libp2p.getMultiaddrs().forEach((addr) => {
  pino.logger.info(`Listening on ${addr.toString()}`)
})

helia.libp2p.addEventListener('peer:discovery', (evt) => {
  const peer = evt.detail
  if (logNewPeers) {
    pino.logger.info(`Discovered peer: ${peer.id}`)
  }
})

helia.libp2p.addEventListener('peer:connect', (evt) => {
  const peerId = evt.detail

  if (logNewPeers) {
    pino.logger.info(`Peer connected: ${peerId}`)
  }
})

helia.libp2p.addEventListener('peer:disconnect', (evt) => {
  const peerId = evt.detail

  if (logNewPeers) {
    pino.logger.info(`Peer disconnected: ${peerId}`)
  }
})

helia.libp2p.addEventListener('start', (event) => {
  pino.logger.info('Libp2p node started')
})

helia.libp2p.addEventListener('stop', (event) => {
  pino.logger.info('Libp2p node stopped')
})

const ifs = unixfs(helia)

pino.logger.info(`Helia is running! PeerID: ${helia.libp2p.peerId.toString()}`)

autoPeering.start()

const PORT = config.serverPort
const app = express()

app.use(pino)

app.get('/', (req, res) => {
  res.send('IPFS node')
})

app.get('/routing/findProviders/:cid', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    const providers: string[] = []
    for await (const provider of helia.routing.findProviders(cid)) {
      pino.logger.info(`Found provider of CID:${cid.toString()}, PeerId:${provider.id.toString()}`)
      providers.push(provider.id.toString())
    }

    res.send({
      providers
    })
  } catch (err) {
    res.send({
      error: err.message
    })
    pino.logger.error(err)
  }
})

app.get('/cron/autopeering', async (req, res) => {
  const successPeers = await autoPeeringHandler()

  res.send({
    peeredSuccessfullyTo: successPeers
  })
})

app.get(
  '/libp2p/services/ping',
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

app.get(
  '/libp2p/peerStore',
  async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
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
  }
)

app.get('/libp2p/peerInfo', async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
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

app.get(
  '/libp2p/dial',
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

app.get('/libp2p/new-peers/log', async (req, res) => {
  logNewPeers = !logNewPeers

  res.send({
    logNewPeers
  })
})

app.get(
  '/libp2p/connections',
  async (req: Request<never, never, never, PeerIdDto>, res: Response) => {
    const peerId = req.query.peerId?.toString() || ''
    const connections = helia.libp2p.getConnections(peerId ? peerIdFromString(peerId) : undefined)

    res.send({
      length: connections.length,
      connections
    })
  }
)

app.get('/libp2p/status', async (req, res) => {
  res.send({
    status: helia.libp2p.status
  })
})

app.get('/file/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const timeoutPromise = new Promise<globalThis.Response>((_, reject) =>
    setTimeout(() => reject(new Error('Operation timed out')), config.findFileTimeout)
  )

  try {
    const filePromise = await verifiedFetch(`ipfs://${cid}`, {
      headers: req.headers as Record<string, string>
    })

    const result = await Promise.race([filePromise, timeoutPromise])
    const data = result.body
    if (!data) {
      throw new Error('Empty data')
    }
    res.set('Content-Type', 'application/octet-stream')
    const responseStream = Writable.toWeb(res)
    await data.pipeTo(responseStream)
  } catch (error) {
    pino.logger.error(error)
    if (error.message === 'Operation timed out') {
      res.status(408).send({
        error: 'Can not find requested CID. Operation timed out.'
      })
    } else {
      res.status(500).send({
        error: 'Internal Server Error. Check the logs for details.'
      })
    }
  }
})

app.get('/pins', async (req, res) => {
  const pins: Pin[] = []

  for await (const pin of helia.pins.ls()) {
    pino.logger.info('PIN LS', pin)
    pins.push(pin)
  }

  res.send({
    pins
  })
})

app.post('/pins/pin/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  try {
    for await (const pin of helia.pins.add(cid)) {
      pino.logger.info('PINNED', pin)
    }
  } catch (err) {
    pino.logger.error(`Error: ${err.message}`)
    res.statusCode = 500
    return res.send({
      error: err.message
    })
  }

  res.send({
    pinned: true,
    cid: cid.toString()
  })
})

app.get('/pins/isPinned/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const isPinned = await helia.pins.isPinned(cid)

  res.send({
    cid: cid.toString(),
    isPinned
  })
})

app.post(
  '/file/upload',
  upload.array('files', 5),
  async (
    req: Request & { files?: { [fieldname: string]: Multer.File[] } | Multer.File[] },
    res
  ) => {
    if (!req.files) {
      res.statusCode = 400
      return res.send({
        error: 'No file uploaded'
      })
    }
    const files = flatFiles(req.files)
    pino.logger.info(`req.files: : ${JSON.stringify(files.map((item) => item.originalName))}`)

    const cids: CID[] = []
    for (const file of files) {
      console.log(`Adding ${file.originalName} to IPFS`)

      const { stream, originalName } = file

      const cid = await ifs.addFile({
        path: `/${originalName}`,
        content: stream
      })
      pino.logger.info(`Successfully added file ${cid}`)
      cids.push(cid)

      const isPinned = await helia.pins.isPinned(cid)
      if (isPinned) {
        pino.logger.info(`File already pinned ${cid}`)
      } else {
        // Pin the file
        for await (const pinned of helia.pins.add(cid)) {
          pino.logger.info(`Filed pinned: ${pinned}`)
        }
      }

      // Tell the network we can provide content for the passed CID
      const dht = helia.libp2p.services.dht as KadDHT
      await dht.provide(cid)
      pino.logger.info(`Provided CID via DHT ${cid}`)

      pino.logger.info(`Routing: Providing ${cid}`)
      void helia.routing.provide(cid)
      pino.logger.info('Routing: Provide DONE')
    }

    res.send({
      filesNames: files.map((file) => file.originalName),
      cids: cids.map((cid) => cid.toString())
    })
  }
)

app.post('/test', async (req, res) => {
  const textEncoder = new TextEncoder()
  const cid = await ifs.addFile({
    content: textEncoder.encode('Hello world asldgfhkasjdghsk;adjflkasgjd!')
  })

  const dht = helia.libp2p.services.dht as KadDHT
  for await (const event of dht.provide(cid)) {
    pino.logger.info('PROVIDE', event)
  }

  res.send({
    cid: cid.toString()
  })
})

app.listen(PORT, () => {
  pino.logger.info(`Server is running on http://localhost:${PORT}`)
})
