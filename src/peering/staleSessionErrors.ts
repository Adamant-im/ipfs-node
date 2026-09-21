/**
 * Detect libp2p session-stale failures on replication streams.
 *
 * Call this only from replication error paths. Substring matching is coarse:
 * `'stream ended before'` also appears in the health protocol, and
 * `'The connection is closed'` can match a benign shutdown race. A match
 * triggers reactive recovery (immediate hang-up and redial).
 */
export function isStalePeerSessionError(message: string): boolean {
  return (
    message.includes('stream that is closed') ||
    message.includes('Replication stream ended before') ||
    message.includes('Replication request timed out') ||
    message.includes('Replication message timed out') ||
    message.includes('The connection is closed') ||
    message.includes('The stream has been reset') ||
    message.includes('stream has been reset') ||
    message.includes('stream reset') ||
    message.includes('connection reset') ||
    message.includes('ECONNRESET') ||
    message.includes('EPIPE')
  )
}
