import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Key } from 'interface-datastore'
import { FsDatastore } from 'datastore-fs'
import { loadHealthCheckpoint, saveHealthCheckpoint } from '../src/health/persistence.js'
import type { HealthCheckpoint } from '../src/health/state.js'

const CHECKPOINT_KEY = new Key('/adm/health/checkpoint')
const MEMBERSHIP = 'a'.repeat(64)
const NOW = 1_720_614_998_797

const valid: HealthCheckpoint = {
  height: 1_720_614_960_000,
  completedAt: 1_720_614_998_700,
  membershipVersion: MEMBERSHIP,
  attestedPeers: 2
}

let directory: string
let datastore: FsDatastore

/** Write a raw value under the checkpoint key, bypassing the writer's shape. */
async function writeRaw(value: unknown): Promise<void> {
  await datastore.put(CHECKPOINT_KEY, new TextEncoder().encode(JSON.stringify(value)))
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ipfs-node-health-'))
  datastore = new FsDatastore(join(directory, 'datastore'))
  await datastore.open()
})

after(async () => {
  await datastore.close()
  await rm(directory, { recursive: true, force: true })
})

describe('health checkpoint persistence', () => {
  it('survives a clean restart', async () => {
    await saveHealthCheckpoint(datastore, valid)

    assert.deepEqual(await loadHealthCheckpoint(datastore, NOW), valid)
  })

  it('reports no checkpoint when the state was never written', async () => {
    await datastore.delete(CHECKPOINT_KEY)

    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)
    await saveHealthCheckpoint(datastore, valid)
  })

  it('ignores a malformed or truncated record', async () => {
    await datastore.put(CHECKPOINT_KEY, new TextEncoder().encode('{"height":'))
    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)

    await writeRaw('not an object')
    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)

    await writeRaw(null)
    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)
  })

  it('rejects negative counts and timestamps', async () => {
    for (const broken of [
      { ...valid, height: -1 },
      { ...valid, completedAt: -1 },
      { ...valid, attestedPeers: -1 }
    ]) {
      await writeRaw(broken)
      assert.equal(await loadHealthCheckpoint(datastore, NOW), null)
    }
  })

  it('rejects a membership version that is not a digest', async () => {
    for (const version of ['', 'short', 'A'.repeat(64), 'z'.repeat(64)]) {
      await writeRaw({ ...valid, membershipVersion: version })
      assert.equal(await loadHealthCheckpoint(datastore, NOW), null)
    }
  })

  it('rejects a height that could not belong to the round it claims', async () => {
    // A round starts at or before the attempt that completed it. A height above
    // it would be carried forward by `Math.max` and advertised indefinitely.
    await writeRaw({ ...valid, height: valid.completedAt + 1 })
    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)

    await writeRaw({ ...valid, height: Number.MAX_SAFE_INTEGER })
    assert.equal(await loadHealthCheckpoint(datastore, NOW), null)
  })

  it('rejects a checkpoint from ahead of the clock after a rollback', async () => {
    await saveHealthCheckpoint(datastore, valid)

    // The clock moved back past the write, so the round it claims never happened
    // on this node's current timeline.
    assert.equal(await loadHealthCheckpoint(datastore, valid.completedAt - 3_600_000), null)

    // Movement inside the tolerated skew still loads.
    assert.deepEqual(await loadHealthCheckpoint(datastore, valid.completedAt - 1_000), valid)
  })
})
