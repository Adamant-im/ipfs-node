import { Router } from 'express'
import { Pin } from 'helia'
import { helia } from '../helia.js'
import { confirmFile } from '../storage/service.js'
import { logger } from '../utils/logger.js'
import { pinLimiter, readLimiter } from '../middleware/rateLimiter.js'
import { parseCid } from '../utils/cid.js'

const router = Router()

router.get('/pins', readLimiter, async (req, res, next) => {
  try {
    const pins: Pin[] = []

    for await (const pin of helia.pins.ls()) {
      logger.info(`Pinned CID: ${pin.cid.toString()}`)
      pins.push(pin)
    }

    res.send({ pins })
  } catch (err) {
    next(err)
  }
})

/**
 * Pin arbitrary content and record it as durable.
 *
 * The file is registered as well as pinned: an unregistered pin is invisible to
 * the storage report and to the garbage collection accounting, which would make
 * the reclaimable estimate wrong.
 */
router.post('/pin/:cid', pinLimiter, async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)
    await confirmFile(cid.toString(), { registerUnknown: true })
    res.send({ pinned: true, cid: cid.toString() })
  } catch (err) {
    next(err)
  }
})

router.get('/pins/isPinned/:cid', readLimiter, async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)

    const isPinned = await helia.pins.isPinned(cid)

    res.send({
      cid: cid.toString(),
      isPinned
    })
  } catch (err) {
    next(err)
  }
})

export default router
