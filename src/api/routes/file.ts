import { Router } from 'express'
import { CID } from 'multiformats/cid'

import { config } from '../../config.js'
import { flatFiles } from '../../services/file/file-stats.js'
import { downloadFile, FileNotFoundError, getFileStats } from '../../services/file/file.js'
import { helia } from '../../services/helia/helia.js'
import { multerStorage } from '../../services/multer/multer.js'
import { UnixFsMulterFile } from '../../services/types.js'
import { logger } from '../../utils/logger.js'

const router = Router()

/**
 * @openapi
 * /api/file/upload:
 *   post:
 *     tags: [File]
 *     summary: Upload files to IPFS
 *     description: Uploads one or more files, adds them to IPFS, and returns their CIDs. Files are also pinned if not already.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Files to be uploaded.
 *     responses:
 *       200:
 *         description: Files uploaded and pinned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filesNames:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of uploaded file names.
 *                 cids:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Corresponding CIDs of the uploaded files.
 *             example:
 *               filesNames:
 *                 - "example.txt"
 *                 - "image.png"
 *               cids:
 *                 - "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
 *                 - "bafybeia6enmtx4fwdl2whnuyr5gy66jjz5rb2cq6g4r2vsmilxv5gpkh7a"
 *       400:
 *         description: Bad request – No files or file count exceeds limit
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message describing the issue.
 *             examples:
 *               noFile:
 *                 summary: No files uploaded
 *                 value:
 *                   error: "No file uploaded"
 *               fileLimitExceeded:
 *                 summary: Too many files uploaded
 *                 value:
 *                   error: "File limit exceeded. Max 5 allowed."
 *       500:
 *         description: internal server error
 *         content:
 *           application/json:
 *             schema:
 *              type: object
 *              properties:
 *                error:
 *                  type: string
 *                  description: error message describing the issue.
 *             example:
 *               error: "internal server error. see logs."
 */
router.post('/upload', multerStorage.array('files'), async (req, res) => {
  if (!req.files) {
    res.status(400).send({
      error: 'No file uploaded'
    })
    return
  }

  if (req.files.length > config.maxFileCount) {
    res.status(400).send({
      error: `File limit exceeded. Max ${config.maxFileCount} allowed.`
    })
    return
  }

  try {
    const files = flatFiles(req.files as UnixFsMulterFile[])
    logger.info(`req.files: : ${JSON.stringify(files.map((item) => item.originalname))}`)

    const cids: CID[] = []
    for (const file of files) {
      logger.info(`Adding ${file.originalname} to IPFS`)

      const { cid } = file
      logger.info(`Successfully added file ${cid}`)
      cids.push(cid)

      const isPinned = await helia.pins.isPinned(cid)
      if (isPinned) {
        logger.info(`File already pinned: ${cid}`)
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
  } catch (error) {
    logger.error(error)

    res.status(400).send({
      error: error.message
    })
  }
})

/**
 * @openapi
 * /api/file/{cid}:
 *   get:
 *     tags: [File]
 *     summary: Download file by CID
 *     description: Streams a file from IPFS corresponding to the given CID. The response is a binary stream with appropriate headers.
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *         description: Content Identifier (CID) of the file to download.
 *     responses:
 *       200:
 *         description: File stream starts successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       408:
 *         description: File not found or failed to stream
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             examples:
 *               notFound:
 *                 summary: File not found
 *                 value:
 *                   error: "Cannot find requested CID. Request timed out."
 *               streamError:
 *                 summary: Stream error
 *                 value:
 *                   error: "Failed to stream file"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *             example:
 *               error: "Internal Server Error. See logs."
 */
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
