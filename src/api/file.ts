import { Router } from 'express'
import { CID } from 'multiformats/cid'
import { multerStorage } from '../multer.js'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { pino } from '../utils/logger.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'
import { downloadFile, FileNotFoundError, getFileStats } from '../utils/file.js'
import { writeLimiter, readLimiter } from '../middleware/rateLimiter.js'

const router = Router()

router.post('/upload', writeLimiter, multerStorage.array('files'), async (req, res, next) => {
  if (!req.files) {
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
    pino.logger.info(`req.files: ${JSON.stringify(files.map((item) => item.originalname))}`)

    const cids: CID[] = []
    for (const file of files) {
      pino.logger.info(`Adding ${file.originalname} to IPFS`)

      const { cid } = file
      pino.logger.info(`Successfully added file ${cid}`)
      cids.push(cid)

      const isPinned = await helia.pins.isPinned(cid)
      if (isPinned) {
        pino.logger.info(`File already pinned ${cid}`)
      } else {
        for await (const pinned of helia.pins.add(cid)) {
          pino.logger.info(`Filed pinned: ${pinned}`)
        }
      }
    }

    res.send({
      filesNames: files.map((file) => file.originalname),
      cids: cids.map((cid) => cid.toString())
    })
  } catch (err) {
    pino.logger.error(err)

    next(err)
  }
})

router.get('/:cid', readLimiter, async (req, res, next) => {
  try {
    const cid = CID.parse(req.params.cid)
    const fileStats = await getFileStats(cid)

    let streamStarted = false
    const stream = downloadFile(cid)

    stream.on('data', () => {
      if (!streamStarted) {
        streamStarted = true
        res.set('Content-Type', 'application/octet-stream')
        res.set('Content-Length', fileStats.fileSize.toString())
      }
    })

    stream.on('error', (err) => {
      pino.logger.error(err)
      next(err)
    })

    stream.pipe(res)
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      res.status(404).send({ error: 'File not found' })
      return
    }
    next(error)
  }
})

export default router
