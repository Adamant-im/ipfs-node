import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import multer from 'multer'

const userHomeDir = homedir()

export const blockstorePath = join(userHomeDir, config.storeFolder, 'blockstore')
export const datastorePath = join(userHomeDir, config.storeFolder, 'datastore')

export const blockstore = new FsBlockstore(blockstorePath)
export const datastore = new FsDatastore(datastorePath)

const filestorePath = join(userHomeDir, config.storeFolder, 'filestore')
if (!existsSync(filestorePath)) {
  mkdirSync(filestorePath, { recursive: true })
}
export const filestore = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, filestorePath)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, file.fieldname + '-' + uniqueSuffix)
  }
})
