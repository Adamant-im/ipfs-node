import { CronJob } from 'cron'
import { helia } from './helia.js'
import { getNodesList } from './utils/utils.js'
import { pino } from './utils/logger.js'

/**
 * Auto-peering between ADM IPFS nodes.
 */
export const autoPeering = new CronJob('*/10 * * * * *', () => {
  autoPeeringHandler().catch(pino.logger.error)
})

export async function autoPeeringHandler() {
  const peerId = helia.libp2p.peerId
  pino.logger.info(
    `[Cron] Running "autoPeering" cronjob. Current node peerId: ${helia.libp2p.peerId}`
  )

  const nodes = getNodesList([peerId.toString()])
  pino.logger.info(`Peering nodes list: ${nodes.map((node) => node.name)}`)

  const successPeers: string[] = []

  for await (const node of nodes) {
    pino.logger.info(`Start peering ${node.name} node (${node.multiAddr})...`)
    try {
      await helia.libp2p.dial(node.multiAddr)
      pino.logger.info(`Successfully peered with ${node.name}`)
      successPeers.push(node.name)
    } catch (err) {
      pino.logger.info(`Peering with ${node.name} failed. Error: ${err.message}`)
    }
  }

  return successPeers
}
