import { Router } from 'express'
import { Pin } from 'helia'
import { CID } from 'multiformats/cid'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.get('/pins', async (req, res) => {
  const pins: Pin[] = []

  for await (const pin of helia.pins.ls()) {
    logger.info(`Pinned CID: ${pin.cid.toString()}`)
    pins.push(pin)
  }

  res.send({
    pins
  })
})

router.post('/pin/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  try {
    // `pins.add` yields the CID of every block it walks while pinning the DAG
    for await (const pinnedCid of helia.pins.add(cid)) {
      logger.info(`Pinned block: ${pinnedCid.toString()}`)
    }
  } catch (err) {
    logger.error(`Error: ${err.message}`)
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

router.get('/pins/isPinned/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const isPinned = await helia.pins.isPinned(cid)

  res.send({
    cid: cid.toString(),
    isPinned
  })
})

export default router
