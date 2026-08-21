import { Router } from 'express'
import { logger } from '../utils/logger.js'
import { getNodesList } from '../utils/utils.js'
import { helia } from '../helia.js'

const router = Router()

router.get('/autopeering', async (req, res) => {
  try {
    const nodes = getNodesList([helia.libp2p.peerId.toString()])
    logger.info(`Peering nodes list: ${nodes.map((node) => node.name)}`)

    const successPeers: string[] = []

    for await (const node of nodes) {
      logger.info(`Start peering ${node.name} node (${node.multiAddr})...`)
      try {
        await helia.libp2p.dial(node.multiAddr)
        logger.info(`Successfully peered with ${node.name}`)
        successPeers.push(node.name)
      } catch (err) {
        logger.info(`Peering with ${node.name} failed. Error: ${err.message}`)
      }
    }

    res.send({
      peeredSuccessfullyTo: successPeers
    })
  } catch (err) {
    logger.error(err)
    res.send({
      error: err.message
    })
  }
})

export default router
