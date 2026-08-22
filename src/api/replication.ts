import { Router } from 'express'
import { pinLimiter } from '../middleware/rateLimiter.js'
import { acceptReplica } from '../storage/service.js'
import { parseCid } from '../utils/cid.js'
import { logger } from '../utils/logger.js'

const router = Router()

/**
 * Store a copy on behalf of another ADAMANT node.
 *
 * The DAG is pulled over libp2p and pinned before the response is sent, so a
 * `200` means the copy is durable here. Access is granted by the shared
 * replication token, not by the administrative key; see `accessPolicy.ts`.
 */
router.post('/:cid', pinLimiter, async (req, res) => {
  const cid = parseCid(req.params.cid)

  try {
    const record = await acceptReplica(cid.toString())
    res.send({ cid: record.cid, state: record.state, storedBytes: record.storedBytes })
  } catch (err) {
    // A peer that cannot serve the DAG is an expected outcome, not a node fault.
    logger.warn(`Replication of ${cid.toString()} failed: ${(err as Error).message}`)
    res.status(502).send({ error: 'Unable to store the replica' })
  }
})

export default router
