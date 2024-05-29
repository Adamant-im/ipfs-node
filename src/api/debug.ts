import { Router } from 'express'
import { pino } from '../utils/logger.js'
import { autoPeeringHandler } from '../auto-peering.cron.js'

const router = Router()

router.get('/debug/autopeering', async (req, res) => {
  try {
    const successPeers = await autoPeeringHandler()

    res.send({
      peeredSuccessfullyTo: successPeers
    })
  } catch (err) {
    pino.logger.error(err)
    res.send({
      error: err.message
    })
  }
})

export default router
