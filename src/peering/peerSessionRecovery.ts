/** Do not reset the same peer more than once in this window. */
export const RECOVERY_COOLDOWN_MS = 30_000

const lastRecoveryAt = new Map<string, number>()

export type PeerSessionRecoveryActions = {
  isConfiguredPeer: (peerId: string) => boolean
  ping: (peerId: string) => Promise<boolean>
  reset: (peerId: string) => Promise<void>
  redial: (peerId: string) => Promise<void>
  now: () => number
}

/**
 * Drop connections to a configured peer after a failed ping and redial that peer.
 *
 * @param peerId Configured peer identifier string
 * @param reason Operator-facing explanation. Unused here; kept on the core
 *   signature so the runtime wrapper can log the same argument
 * @param actions Recovery hooks (required in unit tests to avoid starting Helia)
 */
export function recoverPeerSession(
  peerId: string,
  reason: string,
  actions: PeerSessionRecoveryActions
): void {
  if (!actions.isConfiguredPeer(peerId)) {
    return
  }

  const now = actions.now()
  const last = lastRecoveryAt.get(peerId)

  if (last !== undefined && now - last < RECOVERY_COOLDOWN_MS) {
    return
  }

  lastRecoveryAt.set(peerId, now)

  void (async () => {
    try {
      const alive = await actions.ping(peerId)

      if (alive) {
        return
      }

      await actions.reset(peerId)
      await actions.redial(peerId)
    } catch {
      // Caller/runtime logs failures when a real node is available.
    }
  })()
}

/** Clear cooldown state between unit tests. */
export function resetPeerSessionRecoveryStateForTests(): void {
  lastRecoveryAt.clear()
}
