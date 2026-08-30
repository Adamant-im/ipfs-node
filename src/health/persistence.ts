import { Key } from 'interface-datastore'
import type { Datastore } from 'interface-datastore'
import type { HealthCheckpoint } from './state.js'

const CHECKPOINT_KEY = new Key('/adm/health/checkpoint')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function parseCheckpoint(value: unknown): HealthCheckpoint | null {
  const item = value as Partial<HealthCheckpoint>

  if (
    item === null ||
    !Number.isSafeInteger(item.height) ||
    !Number.isSafeInteger(item.completedAt) ||
    typeof item.membershipVersion !== 'string' ||
    !Number.isSafeInteger(item.attestedPeers)
  ) {
    return null
  }

  return item as HealthCheckpoint
}

/** Load the last durable checkpoint, ignoring malformed legacy or partial data. */
export async function loadHealthCheckpoint(store: Datastore): Promise<HealthCheckpoint | null> {
  try {
    return parseCheckpoint(JSON.parse(decoder.decode(await store.get(CHECKPOINT_KEY))) as unknown)
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_NOT_FOUND' || err instanceof SyntaxError) {
      return null
    }
    throw err
  }
}

/** Persist a completed checkpoint atomically through the datastore implementation. */
export async function saveHealthCheckpoint(
  store: Datastore,
  checkpoint: HealthCheckpoint
): Promise<void> {
  await store.put(CHECKPOINT_KEY, encoder.encode(JSON.stringify(checkpoint)))
}
