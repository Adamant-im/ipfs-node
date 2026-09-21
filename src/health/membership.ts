import { createHash } from 'node:crypto'
import { peerIdFromMultiaddr } from '../utils/utils.js'
import type { ConfigNode } from '../config.js'

/** Stable identifier for the configured peer set used by checkpoint attestations. */
export function membershipVersion(nodes: ConfigNode[]): string {
  const peerIds = nodes.map((node) => peerIdFromMultiaddr(node.multiAddr).toString()).sort()
  return createHash('sha256').update(peerIds.join('\n')).digest('hex')
}
