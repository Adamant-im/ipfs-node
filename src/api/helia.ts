import { Router } from 'express'
import { Pin } from 'helia'
import { CID } from 'multiformats/cid'
import { helia } from '../helia.js'
import { pino } from '../utils/logger.js'
import { writeLimiter, readLimiter } from '../middleware/rateLimiter.js'

const router = Router()

router.get('/pins', readLimiter, async (req, res) => {
  const pins: Pin[] = []

  for await (const pin of helia.pins.ls()) {
    pino.logger.info('PIN LS', pin)
    pins.push(pin)
  }

  res.send({
    pins
  })
})

router.post('/pin/:cid', writeLimiter, async (req, res, next) => {
  try {
    const cid = CID.parse(req.params.cid)
    for await (const pin of helia.pins.add(cid)) {
      pino.logger.info('PINNED', pin)
    }
    res.send({ pinned: true, cid: cid.toString() })
  } catch (err) {
    next(err)
  }
})

router.get('/pins/isPinned/:cid', readLimiter, async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const isPinned = await helia.pins.isPinned(cid)

  res.send({
    cid: cid.toString(),
    isPinned
  })
})

router.get('/routing/findProviders/:cid', readLimiter, async (req, res, next) => {
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
    pino.logger.error(err)
    next(err)
  }
})

export default router
