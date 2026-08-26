import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FsDatastore } from 'datastore-fs'
import { createAdmissionId, recoverInterruptedAdmissions } from '../src/storage/admission.js'
import { FileRegistry, type FileRecord } from '../src/storage/registry.js'

const CID_A = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const CID_B = 'bafkreihfzyt2g6pbd4rhk67deek7xh33xams74spn72eqq5qhx2ypphvii'

let directory: string
let datastore: FsDatastore

const record = (cid: string, admissionId: string): FileRecord => ({
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
  replicas: [],
  admissionId
})

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ipfs-node-admission-'))
  datastore = new FsDatastore(join(directory, 'datastore'))
  await datastore.open()
})

after(async () => {
  await datastore.close()
  await rm(directory, { recursive: true, force: true })
})

describe('upload admission recovery', () => {
  it('clears only tokens left by an earlier process', async () => {
    const registry = new FileRegistry(datastore, '/adm/admission-recovery')
    const currentId = createAdmissionId()
    await registry.save(record(CID_A, 'previous-process:request'))
    await registry.save(record(CID_B, currentId))

    const report = await recoverInterruptedAdmissions(registry)

    assert.deepEqual(report, { checked: 1, recovered: 1, errors: [] })
    assert.equal((await registry.get(CID_A))?.admissionId, undefined)
    assert.equal((await registry.get(CID_B))?.admissionId, currentId)
  })

  it('keeps a settled token from an earlier process for commit retry', async () => {
    const registry = new FileRegistry(datastore, '/adm/admission-recovery-settled')
    await registry.save({
      ...record(CID_A, 'previous-process:settled'),
      admissionSettledAt: 1
    })

    const report = await recoverInterruptedAdmissions(registry)

    assert.deepEqual(report, { checked: 0, recovered: 0, errors: [] })
    assert.equal((await registry.get(CID_A))?.admissionId, 'previous-process:settled')
  })
})
