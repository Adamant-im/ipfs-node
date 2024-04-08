import { CronJob } from "cron";
import { helia } from "./helia.js";
import { getNodesList } from "./utils.js";

/**
 * Auto-peering between ADM IPFS nodes.
 */
export const autoPeering = new CronJob("*/10 * * * * *", autoPeeringHandler);

export async function autoPeeringHandler() {
  const peerId = helia.libp2p.peerId;
  console.log(
    `[Cron] Running "autoPeering" cronjob. Current node peerId: ${helia.libp2p.peerId}`,
  );

  const nodes = getNodesList([peerId.toString()]);
  console.log(
    "Peering nodes list:",
    nodes.map((node) => node.name),
  );

  const successPeers = [];

  for await (const node of nodes) {
    console.log(`Start peering ${node.name} node (${node.multiaddr})...`);
    try {
      const connection = await helia.libp2p.dial(node.multiaddr);
      console.log(`Successfully peered with ${node.name}`);
      successPeers.push(node.name);
    } catch (err) {
      console.log(`Peering with ${node.name} failed. Error:`, err.message);
    }
  }

  return successPeers;
}
