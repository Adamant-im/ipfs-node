import { Router } from 'express'
import { Pin } from 'helia'
import { CID } from 'multiformats/cid'

import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'

const router = Router()

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
 *                         type: object
 *                         properties:
 *                             /:
 *                               type: string
 *                               description: The CID of the pinned content.
 *                       depth:
 *                         type: number
 *                         nullable: true
 *                       metadata:
 *                         type: object
 *             example:
 *               pins:
 *                 - cid:
 *                     /: "bafkreihn5kx7h4lxjljirbtto4gg2zajpy4rxq3c27lpwneyfxpq57iyzm"
 *                   depth: null
 *                   metadata: {}
 *                 - cid:
 *                     /: "bafkreiapwelzbhrvqfpqqczq2z3qmk3dhpbvrar3jsxzqh6fw3gfczyvru"
 *                   depth: null
 *                   metadata: {}
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: error message describing the issue.
 *             example:
 *               error: "Internal server error. See logs."
 */
router.get('/pins', async (req, res) => {
  try {
    const pins: Pin[] = []

    for await (const pin of helia.pins.ls()) {
      pins.push(pin)
    }

    res.send({
      pins
    })
  } catch (error) {
    logger.error(error)
    // Unable to determine error
    res.status(500).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/helia/pins/{cid}/pin:
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
 *               cid: "bafkreiapwelzbhrvqfpqqczq2z3qmk3dhpbvrar3jsxzqh6fw3gfczyvru"
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
 *               error: "Already pinned"
 */
router.post('/pins/:cid/pin', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    for await (const pin of helia.pins.add(cid)) {
      logger.info(`Pinned ${cid.toString()} block: ${pin}`)
    }

    res.send({
      pinned: true,
      cid: cid.toString()
    })
  } catch (error) {
    logger.error(error)
    // Unable to determine error
    res.status(500).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/helia/pins/{cid}/unpin:
 *   post:
 *     tags: [Helia]
 *     summary: Unpin a CID in Helia
 *     description: Unpins the block that corresponds to the passed CID. The block will be deleted when garbage collection is run.
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *         description: The CID to pin.
 *     responses:
 *       200:
 *         description: CID unpinned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pinned:
 *                   type: boolean
 *                   description: Indicates if the CID was unpinned.
 *                 cid:
 *                   type: string
 *                   description: The unpinned CID.
 *             example:
 *               unpinned: true
 *               cid: "bafkreiapwelzbhrvqfpqqczq2z3qmk3dhpbvrar3jsxzqh6fw3gfczyvru"
 *       500:
 *         description: Error unpinning the CID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Error: ENOENT: no such file or directory"
 */
router.post('/pins/:cid/unpin', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    for await (const pin of helia.pins.rm(cid)) {
      logger.info(`Unpinned ${cid.toString()} block: ${pin}`)
    }

    res.send({
      unpinned: true,
      cid: cid.toString()
    })
  } catch (error) {
    logger.error(error)
    // Unable to determine error
    res.status(500).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/helia/pins/{cid}/isPinned:
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
 *               cid: "bafkreiapwelzbhrvqfpqqczq2z3qmk3dhpbvrar3jsxzqh6fw3gfczyvru"
 *               isPinned: true
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: error message describing the issue.
 *             example:
 *               error: "Internal server error. See logs."
 */
router.get('/pins/:cid/isPinned', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    const isPinned = await helia.pins.isPinned(cid)

    res.send({
      cid: cid.toString(),
      isPinned
    })
  } catch (error) {
    logger.error(error)
    // Unable to determine error
    res.status(500).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/helia/pins/{cid}/providers:
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
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: error message describing the issue.
 *             example:
 *               error: "Internal server error. See logs."
 */
router.get('/pins/:cid/providers', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)

    const providers: string[] = []
    /**
     * TODO: This fails and need to be fixed
     * Requires to add some providers?
     */
    for await (const provider of helia.routing.findProviders(cid)) {
      logger.info(`Found provider of CID:${cid.toString()}, PeerId:${provider.id.toString()}`)
      providers.push(provider.id.toString())
    }

    res.send({
      providers
    })
  } catch (error) {
    logger.error(error)
    // Unable to determine error
    res.send({
      error: error.message
    })
  }
})

export default router
