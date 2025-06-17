import { Router } from 'express'
import { Pin } from 'helia'
import { CID } from 'multiformats/cid'

import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'

const router = Router()

// TODO: This should be totally updated

/**
 * @openapi
 * /api/helia/pins:
 *   get:
 *     tags: [Helia]
 *     summary: List all pinned CIDs in Helia
 *     description: Retrieves a list of all pinned content identifiers (CIDs) managed by Helia.
 *     responses:
 *       200:
 *         description: List of pinned CIDs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pins:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       cid:
 *                         type: string
 *                         description: The CID of the pinned content.
 *                       type:
 *                         type: string
 *                         description: The type of pin (e.g., recursive, direct).
 *             example:
 *               pins:
 *                 - cid: "QmXf123abc..."
 *                   type: "recursive"
 *                 - cid: "QmYz456def..."
 *                   type: "direct"
 */
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

/**
 * @openapi
 * /api/helia/pin/{cid}:
 *   post:
 *     tags: [Helia]
 *     summary: Pin a CID in Helia
 *     description: Pins the specified CID to ensure its content is retained locally.
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *         description: The CID to pin.
 *     responses:
 *       200:
 *         description: CID pinned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pinned:
 *                   type: boolean
 *                   description: Indicates if the CID was pinned.
 *                 cid:
 *                   type: string
 *                   description: The pinned CID.
 *             example:
 *               pinned: true
 *               cid: "QmXf123abc..."
 *       500:
 *         description: Error pinning the CID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Failed to pin CID due to internal error"
 */
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

/**
 * @openapi
 * /api/helia/pins/isPinned/{cid}:
 *   get:
 *     tags: [Helia]
 *     summary: Check if a CID is pinned in Helia
 *     description: Returns whether the specified CID is currently pinned.
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *         description: The CID to check.
 *     responses:
 *       200:
 *         description: Pin status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cid:
 *                   type: string
 *                   description: The CID checked.
 *                 isPinned:
 *                   type: boolean
 *                   description: True if the CID is pinned, false otherwise.
 *             example:
 *               cid: "QmXf123abc..."
 *               isPinned: true
 */
router.get('/pins/isPinned/:cid', async (req, res) => {
  const cid = CID.parse(req.params.cid)

  const isPinned = await helia.pins.isPinned(cid)

  res.send({
    cid: cid.toString(),
    isPinned
  })
})

/**
 * @openapi
 * /api/helia/routing/findProviders/{cid}:
 *   get:
 *     tags: [Helia]
 *     summary: Find providers for a given CID
 *     description: Retrieves a list of peer IDs that provide the specified CID.
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *         description: The CID to find providers for.
 *     responses:
 *       200:
 *         description: List of providers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 providers:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of peer IDs that provide the CID.
 *             example:
 *               providers:
 *                 - "12D3KooWKavDi49t6qZFuPqMPeehxNqHdDdbqqdvVVv7YasEYppm"
 *                 - "12D3KooWXu8TtyGbfC6KSH82VXkEG2UVsy8vcz5Qk5aY8JDbAqfFo"
 *       400:
 *         description: Error finding providers for the CID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Invalid CID format"
 */
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
