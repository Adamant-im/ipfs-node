import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { FsDatastore } from 'datastore-fs'
import { FileRegistry, type FileRecord } from '../src/storage/registry.js'
import { nextRepairCycleBatch, resetRepairCycle } from '../src/storage/repairCycle.js'
import { SWEEP_BATCHES } from '../src/storage/sweep.js'

let directory: string
let datastore: FsDatastore
let registry: FileRegistry
let prefixCounter = 0

const record = (cid: string): FileRecord => ({
  cid,
  name: cid,
  state: 'confirmed',
  createdAt: 1,
  expiresAt: null,
  confirmedAt: 1,
  fileSize: 100,
  storedBytes: 120,
  protectedBytes: 120,
  pinned: true,
  heldLocally: true,
  replicas: []
})

/** Deterministic CIDs that sort in insertion order. */
const cid = (index: number) => `cid-${String(index).padStart(5, '0')}`

async function seed(count: number, offset = 0): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await registry.withExclusiveCids([cid(offset + index)], async (locked) =>
      locked.save(record(cid(offset + index)))
    )
  }
}

/** Walk to the end of the cycle, returning every batch it handed out. */
async function runCycle(): Promise<{
  visited: string[]
  last: Awaited<ReturnType<typeof nextRepairCycleBatch>>
}> {
  const visited: string[] = []
  let cursor: string | undefined
  let last = await nextRepairCycleBatch(registry, cursor)

  for (let pass = 0; pass < 50; pass += 1) {
    visited.push(...last.cids)
    if (last.cycleCompleted) break
    cursor = last.nextCursor
    last = await nextRepairCycleBatch(registry, cursor)
  }

  return { visited, last }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ipfs-node-repair-cycle-'))
  datastore = new FsDatastore(join(directory, 'datastore'))
  await datastore.open()
})

after(async () => {
  await datastore.close()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(() => {
  resetRepairCycle()
  prefixCounter += 1
  registry = new FileRegistry(datastore, `/adm/repair-cycle-${prefixCounter}`)
})

describe('repair cycle candidate list', () => {
  it('completes over a set that does not change', async () => {
    await seed(SWEEP_BATCHES.repair + 7)

    const { visited, last } = await runCycle()

    assert.equal(last.cycleCompleted, true)
    assert.equal(last.uncovered, 0)
    assert.equal(new Set(visited).size, SWEEP_BATCHES.repair + 7)
  })

  it('completes immediately on an empty registry', async () => {
    const batch = await nextRepairCycleBatch(registry, undefined)

    assert.deepEqual(batch.cids, [])
    assert.equal(batch.cycleCompleted, true)
    assert.equal(batch.uncovered, 0)
  })

  it('covers a record admitted behind the cursor before completing', async () => {
    await seed(SWEEP_BATCHES.repair + 3, 100)

    const first = await nextRepairCycleBatch(registry, undefined)
    assert.equal(first.cycleCompleted, false)

    // Sorts before everything the first pass handed out, so a cursor-only sweep
    // would never reach it and would still report a completed cycle.
    await seed(1, 0)

    const second = await nextRepairCycleBatch(registry, first.nextCursor)
    assert.equal(second.cycleCompleted, false, 'the arrival extends the cycle instead of ending it')

    const third = await nextRepairCycleBatch(registry, second.nextCursor)
    assert.equal(third.cids.includes(cid(0)), true)
    assert.equal(third.cycleCompleted, true)
    assert.equal(third.uncovered, 0)
  })

  it('reads the registry once per cycle rather than once per pass', async () => {
    await seed(SWEEP_BATCHES.repair * 2 + 1)

    let scans = 0
    const counted = new Proxy(registry, {
      get(target, property, receiver) {
        if (property === 'all') {
          return async () => {
            scans += 1
            return target.all()
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      }
    })

    let batch = await nextRepairCycleBatch(counted, undefined)
    while (!batch.cycleCompleted) {
      batch = await nextRepairCycleBatch(counted, batch.nextCursor)
    }

    // One scan to build the list, one at the end to name late arrivals.
    assert.equal(scans, 2)
  })

  it('rebuilds and resumes from the persisted cursor after a restart', async () => {
    await seed(SWEEP_BATCHES.repair + 5)

    const first = await nextRepairCycleBatch(registry, undefined)
    resetRepairCycle()

    const resumed = await nextRepairCycleBatch(registry, first.nextCursor)

    assert.equal(resumed.cids.length, 5)
    assert.equal(
      resumed.cids.some((item) => first.cids.includes(item)),
      false
    )
    assert.equal(resumed.cycleCompleted, true)
  })
})
