import { Router } from 'express'
import { Pin } from 'helia'
import { CID } from 'multiformats/cid'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.get('/pins', async (req, res) => {
  const pins: Pin[] = []

  for await (const pin of helia.pins.ls()) {
    logger.info('PIN LS', pin)
    pins.push(pin)
  }

  res.send({
    pins
  })
})

router.post('/pin/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  try {
    for await (const pin of helia.pins.add(cid)) {
      logger.info('PINNED', pin)
    }
  } catch (err) {
    logger.error(`Error: ${err.message}`)
    res.status(500).send({
      error: err.message
    })
    return
  }

  res.send({
    pinned: true,
    cid: cid.toString()
  })
})

router.get('/pins/isPinned/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const isPinned = await helia.pins.isPinned(cid)

  res.send({
    cid: cid.toString(),
    isPinned
  })
})

router.get('/routing/findProviders/:cid', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    const providers: string[] = []
    for await (const provider of helia.routing.findProviders(cid)) {
      logger.info(`Found provider of CID:${cid.toString()}, PeerId:${provider.id.toString()}`)
      providers.push(provider.id.toString())
    }

    res.send({
      providers
    })
  } catch (err) {
    res.send({
      error: err.message
    })
    logger.error(err)
  }
})

export default router
