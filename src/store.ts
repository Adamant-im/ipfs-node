import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from './config.js'

const userHomeDir = homedir()

export const blockstorePath = join(userHomeDir, config.storeFolder, 'blockstore')
export const datastorePath = join(userHomeDir, config.storeFolder, 'datastore')

export const blockstore = new FsBlockstore(blockstorePath)
export const datastore = new FsDatastore(datastorePath)
