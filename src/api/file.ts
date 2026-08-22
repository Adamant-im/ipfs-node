import { Router } from 'express'
import { CID } from 'multiformats/cid'
import { multerStorage } from '../multer.js'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'
import { downloadFile, getFileStats } from '../utils/file.js'
import { uploadLimiter, readLimiter } from '../middleware/rateLimiter.js'
import { parseCid } from '../utils/cid.js'
import { sendDownloadStream } from '../utils/downloadResponse.js'

const router = Router()

router.post('/upload', uploadLimiter, multerStorage.array('files'), async (req, res, next) => {
  if (!Array.isArray(req.files) || req.files.length === 0) {
    res.statusCode = 400
    return res.send({ error: 'No file uploaded' })
  }

  if (req.files.length > config.maxFileCount) {
    res.status(400).send({
      error: `File limit exceeded. Max ${config.maxFileCount} allowed.`
    })
    return
  }

  try {
    const files = flatFiles(req.files as UnixFsMulterFile[])
    logger.info(`req.files: ${JSON.stringify(files.map((item) => item.originalname))}`)

    const cids: CID[] = []
    for (const file of files) {
      logger.info(`Adding ${file.originalname} to IPFS`)

      const { cid } = file
      logger.info(`Successfully added file ${cid}`)
      cids.push(cid)

      const isPinned = await helia.pins.isPinned(cid)
      if (isPinned) {
        logger.info(`File already pinned ${cid}`)
      } else {
        for await (const pinned of helia.pins.add(cid)) {
          logger.info(`Filed pinned: ${pinned}`)
        }
      }
    }

    res.send({
      filesNames: files.map((file) => file.originalname),
      cids: cids.map((cid) => cid.toString())
    })
  } catch (err) {
    next(err)
  }
})

router.get('/:cid', readLimiter, async (req, res, next) => {
  try {
    const cid = parseCid(req.params.cid)
    const fileStats = await getFileStats(cid)
    const stream = downloadFile(cid)

    sendDownloadStream(
      stream,
      res,
      { cid: cid.toString(), fileSize: fileStats.size },
      next,
      (error) => logger.error(error)
    )
  } catch (error) {
    next(error)
  }
})

export default router
