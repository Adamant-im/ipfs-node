import { join } from 'path'

import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'

import { config } from './config.js'

export const blockstorePath = join(config.storeFolder, 'blockstore')
export const datastorePath = join(config.storeFolder, 'datastore')

export const blockstore = new FsBlockstore(blockstorePath, { createIfMissing: true })
export const datastore = new FsDatastore(datastorePath, { createIfMissing: true })
