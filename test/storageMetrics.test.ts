import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pinnedStorageBytes } from '../src/storage/metrics.js'
import type { FileRecord } from '../src/storage/registry.js'

type Measured = Pick<FileRecord, 'pinned' | 'fileSize' | 'storedBytes' | 'protectedBytes'>

const file = (overrides: Partial<Measured> = {}): Measured => ({
  pinned: true,
  fileSize: 1000,
  storedBytes: 1000,
  protectedBytes: 1000,
  ...overrides
})

describe('pinnedStorageBytes', () => {
  it('measures what a pin protects, not what its upload happened to write', () => {
    // An upload of content this node already held writes no blocks at all. Its
    // pin still protects the whole DAG, and reporting zero would put that
    // storage in the reclaimable column.
    const cachedReupload = file({ storedBytes: 0, protectedBytes: 90_000, fileSize: 90_000 })

    assert.equal(pinnedStorageBytes([cachedReupload]), 90_000)
  })

  it('ignores content no pin protects', () => {
    assert.equal(pinnedStorageBytes([file({ pinned: false })]), 0)
  })

  it('adds up every pinned record', () => {
    assert.equal(
      pinnedStorageBytes([file({ protectedBytes: 10 }), file({ protectedBytes: 25 })]),
      35
    )
  })

  it('falls back for records written before the DAG size was stored', () => {
    // The write delta is exact for a first import, and the logical size keeps a
    // cached re-upload from reading as nothing until it is registered again.
    assert.equal(
      pinnedStorageBytes([file({ protectedBytes: undefined, storedBytes: 0, fileSize: 700 })]),
      700
    )
  })
})
