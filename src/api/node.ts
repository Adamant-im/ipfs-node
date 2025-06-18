import { Router } from 'express'

import { packageJson } from '../config.js'
import { getDiskUsageStats } from '../disk-usage.cron.js'
import { helia } from '../helia.js'

const router = Router()

/**
 * @openapi
 * /api/node/health:
 *   get:
 *     tags: [Node]
 *     summary: Health check endpoint
 *     description: Returns the current server timestamp and the status of the Helia libp2p node.
 *     responses:
 *       200:
 *         description: Successful health check response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: integer
 *                   format: int64
 *                   description: The current server timestamp in milliseconds.
 *                 heliaStatus:
 *                   type: string
 *                   description: The status of the Helia libp2p node.
 *             example:
 *               timestamp: 1718467200000
 *               heliaStatus: "started"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: Error message describing the issue.
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/health', async (req, res) => {
  res.send({
    timestamp: Date.now(),
    heliaStatus: helia.libp2p.status
  })
})

/**
 * @openapi
 * /api/node/info:
 *   get:
 *     tags: [Node]
 *     summary: Node information endpoint
 *     description: Returns metadata about the running node, including version, peer ID, multiaddresses, storage usage, and libp2p status.
 *     responses:
 *       200:
 *         description: Successful node information response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                   description: The version of the running application.
 *                 timestamp:
 *                   type: integer
 *                   format: int64
 *                   description: The current server timestamp in milliseconds.
 *                 heliaStatus:
 *                   type: string
 *                   description: The status of the Helia libp2p node.
 *                 peerId:
 *                   type: string
 *                   description: The libp2p peer ID of the node.
 *                 multiAddresses:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of multiaddresses the node is listening on.
 *                 blockstoreSizeMb:
 *                   type: number
 *                   format: float
 *                   description: Size of the blockstore in megabytes.
 *                 datastoreSizeMb:
 *                   type: number
 *                   format: float
 *                   description: Size of the datastore in megabytes.
 *                 availableSizeInMb:
 *                   type: number
 *                   format: float
 *                   description: Available disk space in megabytes.
 *             example:
 *               version: "1.0.0"
 *               timestamp: 1718467200000
 *               heliaStatus: "started"
 *               peerId: "12D3KooWGMp6SaKon2UKwJsDEf3chLAGRzsjdAfDGN9zcwt6ydqJ"
 *               multiAddresses:
 *                 - "/ip4/194.163.154.252/tcp/4001/p2p/12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq"
 *                 - "/ip4/154.26.159.245/tcp/4001/p2p/12D3KooWJw99nqrQ2L2joFuGCF9EN9EyF8ZrvGr1odQ61HoPrbXd"
 *               blockstoreSizeMb: 120.5
 *               datastoreSizeMb: 35.2
 *               availableSizeInMb: 5024.8
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: Error message describing the issue.
 *             example:
 *               error: "Internal Server Error. See logs."
 */
router.get('/info', async (req, res) => {
  const { blockstoreSizeMb, datastoreSizeMb, availableSizeInMb } = getDiskUsageStats()

  res.send({
    version: packageJson.version,
    timestamp: Date.now(),
    heliaStatus: helia.libp2p.status,
    peerId: helia.libp2p.peerId,
    multiAddresses: helia.libp2p.getMultiaddrs(),
    blockstoreSizeMb,
    datastoreSizeMb,
    availableSizeInMb
  })
})

export default router
