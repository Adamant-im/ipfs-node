import { Router } from 'express'
import { CID } from 'multiformats/cid'
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
  const cid = CID.parse(req.params.cid)

  try {
    const timeoutPromise = new Promise<globalThis.Response>((_, reject) =>
      setTimeout(() => reject(new Error('Operation timed out')), config.findFileTimeout)
    )
    // const filePromise = verifiedFetch(`ipfs://${cid}`, {
    //   headers: req.headers as Record<string, string>
    // })

    const filePromise = (async () => {
      const file = ifs.cat(cid)
      const chunks = []
      for await (const chunk of file) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    })()

    const result = await Promise.race([filePromise, timeoutPromise])
    const data = result
    if (!data) {
      throw new Error('Empty data')
    }
    res.set('Content-Type', 'application/octet-stream')
    // const responseStream = Writable.toWeb(res)

    res.send(result)
  } catch (error) {
    pino.logger.error(error)
    if (error.message === 'Operation timed out') {
      res.status(408).send({
        error: 'Can not find requested CID. Operation timed out.'
      })
    } else {
      res.status(500).send({
        error: 'Internal Server Error. Check the logs for details.'
      })
    }
  }
})

export default router
