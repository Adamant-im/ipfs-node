import { Router } from 'express'
import { CID } from 'multiformats/cid'
import { Readable } from 'node:stream'
import { multerStorage } from '../multer.js'
import { config } from '../config.js'
import { helia, ifs } from '../helia.js'
import { pino } from '../utils/logger.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'

const router = Router()

router.post('/file/upload', multerStorage.array('files', 5), async (req, res) => {
  if (!req.files) {
    res.statusCode = 400
    return res.send({
      error: 'No file uploaded'
    })
  }

  try {
    const files = flatFiles(req.files as UnixFsMulterFile[])
    pino.logger.info(`req.files: : ${JSON.stringify(files.map((item) => item.originalname))}`)

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
        // Pin the file
        for await (const pinned of helia.pins.add(cid)) {
          pino.logger.info(`Filed pinned: ${pinned}`)
        }
      }

      // Tell the network we can provide content for the passed CID
      // const dht = helia.libp2p.services.dht as KadDHT
      // await dht.provide(cid)
      // pino.logger.info(`Provided CID via DHT ${cid}`)
      //
      // pino.logger.info(`Routing: Providing ${cid}`)
      // void helia.routing.provide(cid)
      // pino.logger.info('Routing: Provide DONE')
    }

    res.send({
      filesNames: files.map((file) => file.originalname),
      cids: cids.map((cid) => cid.toString())
    })
  } catch (err) {
    pino.logger.error(err)

    res.status(400)
    res.send({
      error: err.message
    })
  }
})

router.get('/file/:cid', async (req, res) => {
  try {
    const cid = CID.parse(req.params.cid)
    const fileStats = await ifs.stat(cid)
    let streamStarted = false
    const abortController = new AbortController()
    const timeout = setTimeout(() => {
      if (!streamStarted) {
        abortController.abort(new Error('Cannot find requested CID. Request timed out.'))
      }
    }, config.findFileTimeout)

    const stream = Readable.from(
      ifs.cat(cid, {
        signal: abortController.signal
      })
    )

    stream.on('data', () => {
      if (!streamStarted) {
        streamStarted = true
        res.set('Content-Type', 'application/octet-stream')
        res.set('Content-Length', fileStats.fileSize.toString())
      }
    })
    stream.on('error', (err) => {
      pino.logger.error(err)
      res.status(408).send({
        error: err.message
      })
    })
    stream.on('end', () => {
      clearTimeout(timeout)
    })
    stream.pipe(res)
  } catch (error) {
    pino.logger.error(error)
    res.status(500).send({
      error: 'Internal Server Error. Check the logs for details.'
    })
  }
})

export default router
