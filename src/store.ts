import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { homedir } from 'os'
import { join } from 'path'
import config from './config.js'

const userHomeDir = homedir()

export const blockstore = new FsBlockstore(join(userHomeDir, config.storeFolder, 'blockstore'))
export const datastore = new FsDatastore(join(userHomeDir, config.storeFolder, 'datastore'))
