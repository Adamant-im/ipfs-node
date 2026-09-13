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

/**
 * Create the store directories if they are missing.
 *
 * Both stores default to `createIfMissing`, so this is safe to call on an
 * existing store and makes a first run on a clean machine deterministic instead
 * of relying on the first write to create the directory tree.
 */
export async function openStores(): Promise<void> {
  await blockstore.open()
  await datastore.open()
}
