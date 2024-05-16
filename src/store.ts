import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from './config.js'

const userHomeDir = homedir()

export const blockstorePath = join(userHomeDir, config.storeFolder, 'blockstore')
export const heliaDatastorePath = join(userHomeDir, config.storeFolder, 'datastore')
export const libp2pDatastorePath = join(userHomeDir, config.storeFolder, 'datastore_p2p')

export const blockstore = new FsBlockstore(blockstorePath)
export const heliaDatastore = new FsDatastore(heliaDatastorePath)
export const libp2pDatastore = new FsDatastore(libp2pDatastorePath)
