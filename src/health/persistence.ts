import { Key } from 'interface-datastore'
import type { Datastore } from 'interface-datastore'
import type { HealthCheckpoint } from './state.js'

const CHECKPOINT_KEY = new Key('/adm/health/checkpoint')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Shape of a membership version, matching the digest {@link membershipVersion} emits. */
const MEMBERSHIP_VERSION = /^[0-9a-f]{64}$/

/**
 * Clock movement tolerated between writing a checkpoint and reading it back.
 *
 * A checkpoint dated after the current time is only possible if the clock went
 * backwards, which invalidates the round it claims.
 */
const CLOCK_TOLERANCE_MS = 60_000

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Accept only a checkpoint this node could have written.
 *
 * `Number.isSafeInteger` alone admits negative timestamps and peer counts, and
 * a height arbitrarily far in the future. The last of those is not merely
 * cosmetic: `evaluateHealth` carries a height forward with `Math.max`, so one
 * bad value would be advertised by a `ready` node for the rest of its life and
 * could never be corrected by a genuine round.
 */
export function parseCheckpoint(value: unknown, now: number): HealthCheckpoint | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const item = value as Partial<HealthCheckpoint>

  if (
    !isCount(item.height) ||
    !isCount(item.completedAt) ||
    !isCount(item.attestedPeers) ||
    typeof item.membershipVersion !== 'string' ||
    !MEMBERSHIP_VERSION.test(item.membershipVersion) ||
    // The round starts at or before the attempt that completed it.
    item.height > item.completedAt ||
    item.completedAt > now + CLOCK_TOLERANCE_MS
  ) {
    return null
  }

  return {
    height: item.height,
    completedAt: item.completedAt,
    membershipVersion: item.membershipVersion,
    attestedPeers: item.attestedPeers
  }
}

/**
 * Load the last durable checkpoint, ignoring malformed legacy or partial data.
 *
 * @param store node datastore
 * @param now current time, used to reject a checkpoint from ahead of the clock
 * @returns the checkpoint, or `null` when there is none this node can trust
 */
export async function loadHealthCheckpoint(
  store: Datastore,
  now: number = Date.now()
): Promise<HealthCheckpoint | null> {
  try {
    return parseCheckpoint(
      JSON.parse(decoder.decode(await store.get(CHECKPOINT_KEY))) as unknown,
      now
    )
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_NOT_FOUND' || err instanceof SyntaxError) {
      return null
    }
    throw err
  }
}

/**
 * Persist a completed checkpoint as one datastore write.
 *
 * The whole checkpoint is a single key, so a crash leaves either the previous
 * value or the new one. That is durability for this record, not a transaction:
 * a future checkpoint spread over several keys would need one of its own.
 */
export async function saveHealthCheckpoint(
  store: Datastore,
  checkpoint: HealthCheckpoint
): Promise<void> {
  await store.put(CHECKPOINT_KEY, encoder.encode(JSON.stringify(checkpoint)))
}
