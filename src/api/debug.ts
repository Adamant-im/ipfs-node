import { Router } from 'express'
import { logger } from '../utils/logger.js'
import { getNodesList } from '../utils/utils.js'
import { helia } from '../helia.js'

const router = Router()

/**
 * @openapi
 * /api/debug/autopeering:
 *   get:
 *     tags: [Debug]
 *     summary: Attempt to auto-peer with known nodes
 *     description: Attempts to dial and peer with a list of known nodes. Returns the list of nodes that were successfully peered with.
 *     responses:
 *       200:
 *         description: Auto-peering operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 peeredSuccessfullyTo:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of node names successfully peered with.
 *             example:
 *               peeredSuccessfullyTo:
 *                 - "NodeA"
 *                 - "NodeB"
 *       500:
 *         description: Internal server error during auto-peering
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message detailing why the operation failed.
 *             example:
 *               error: "Internal Server Error. See logs."
 */
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
