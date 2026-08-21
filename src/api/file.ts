import { Router } from 'express'
import { CID } from 'multiformats/cid'
import { multerStorage } from '../multer.js'
import { config } from '../config.js'
import { helia } from '../helia.js'
import { logger } from '../utils/logger.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'
import { downloadFile, FileNotFoundError, getFileStats } from '../utils/file.js'

const router = Router()

router.post('/upload', multerStorage.array('files'), async (req, res) => {
  if (!req.files) {
    res.statusCode = 400
    return res.send({
      error: 'No file uploaded'
    })
  }

  // `req.files` is an array for `.array()` uploads, but multer types it as a
  // union with the fieldname map used by `.fields()`, so flatten before counting
  const files = flatFiles(
    req.files as UnixFsMulterFile[] | { [fieldname: string]: UnixFsMulterFile[] }
  )

  if (files.length > config.maxFileCount) {
    res.status(400).send({
      error: `File limit exceeded. Max ${config.maxFileCount} allowed.`
    })
    return
  }

  try {
    logger.info(`req.files: : ${JSON.stringify(files.map((item) => item.originalname))}`)

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
    logger.error(err)

    res.status(400)
    res.send({
      error: err.message
    })
  }
})

router.get('/:cid', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)
    const fileStats = await getFileStats(cid)

    let streamStarted = false
    const stream = downloadFile(cid)

    stream.on('data', () => {
      if (!streamStarted) {
        streamStarted = true
        res.set('Content-Type', 'application/octet-stream')
        res.set('Content-Length', fileStats.size.toString())
      }
    })

    stream.on('error', (err) => {
      logger.error(err)
      res.status(408).send({
        error: err.message
      })
    })

    stream.pipe(res)
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      res.status(408).send({
        error: error.message
      })
    } else {
      logger.error(error)
      res.status(500).send({
        error: error.message
      })
    }
  }
})

export default router
