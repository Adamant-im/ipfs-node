import { config } from './config.js'
import { createIpfsNode, createUnixFs } from './ipfs-node.js'
import { blockstore, datastore, openStores } from './store.js'
import { logger } from './utils/logger.js'
import { getAllowNodesMultiaddrs } from './utils/utils.js'

await openStores()

/**
 * The Helia node backing the HTTP API.
 *
 * Created at import time so that the API routers can share a single node. See
 * `createIpfsNode` for the composition and why the Helia defaults are avoided.
 */
export const helia = await createIpfsNode({
  blockstore,
  datastore,
  listen: config.peerDiscovery.listen,
  bootstrap: config.peerDiscovery.bootstrap,
  allow: getAllowNodesMultiaddrs()
})

helia.libp2p.getMultiaddrs().forEach((addr) => {
  logger.info(`Listening on ${addr.toString()}`)
})

helia.libp2p.addEventListener('peer:discovery', (evt) => {
  logger.info(`Discovered peer: ${evt.detail.id.toString()}`)
})

helia.libp2p.addEventListener('peer:connect', (evt) => {
  logger.info(`Peer connected: ${evt.detail.toString()}`)
})

helia.libp2p.addEventListener('peer:disconnect', (evt) => {
  logger.info(`Peer disconnected: ${evt.detail.toString()}`)
})

helia.events.addEventListener('stop', () => {
  logger.info('Helia node stopped')
})

logger.info(`Helia is running! PeerID: ${helia.libp2p.peerId.toString()}`)

export const ifs = createUnixFs(helia)
