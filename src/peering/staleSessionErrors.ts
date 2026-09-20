/**
 * Patterns that indicate the libp2p session is stale while TCP may still look up.
 */
export function isStalePeerSessionError(message: string): boolean {
  return (
    message.includes('stream that is closed') ||
    message.includes('stream ended before') ||
    message.includes('Replication request timed out') ||
    message.includes('The connection is closed')
  )
}
