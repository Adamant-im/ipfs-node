/** Do not reset the same peer more than once in this window. */
export const RECOVERY_COOLDOWN_MS = 30_000

const lastRecoveryAt = new Map<string, number>()
const inFlightRecoveries = new Map<string, Promise<boolean>>()

export type PeerSessionRecoveryActions = {
  isConfiguredPeer: (peerId: string) => boolean
  ping?: (peerId: string) => Promise<boolean>
  reset: (peerId: string) => Promise<void>
  redial: (peerId: string) => Promise<void>
  now: () => number
}

/**
 * Drop connections to a configured peer after an application-level transfer failure
 * and redial that peer.
 *
 * Ping remains a diagnostic probe and does NOT veto session reset after an application failure.
 *
 * @param peerId Configured peer identifier string
 * @param reason Operator-facing explanation
 * @param actions Recovery hooks (required in unit tests to avoid starting Helia)
 * @returns Whether the session was reset and redialled
 */
export async function recoverPeerSession(
  peerId: string,
  reason: string,
  actions: PeerSessionRecoveryActions
): Promise<boolean> {
  if (!actions.isConfiguredPeer(peerId)) {
    return false
  }

  const inFlight = inFlightRecoveries.get(peerId)
  if (inFlight !== undefined) {
    return inFlight
  }

  const now = actions.now()
  const last = lastRecoveryAt.get(peerId)

  if (last !== undefined && now - last < RECOVERY_COOLDOWN_MS) {
    return false
  }

  lastRecoveryAt.set(peerId, now)

  const recoveryPromise = (async () => {
    try {
      if (actions.ping) {
        await actions.ping(peerId).catch(() => false)
      }

      await actions.reset(peerId)
      await actions.redial(peerId)
      return true
    } catch {
      return false
    } finally {
      inFlightRecoveries.delete(peerId)
    }
  })()

  inFlightRecoveries.set(peerId, recoveryPromise)
  return recoveryPromise
}

/** Clear cooldown and in-flight state between unit tests. */
export function resetPeerSessionRecoveryStateForTests(): void {
  lastRecoveryAt.clear()
  inFlightRecoveries.clear()
}
