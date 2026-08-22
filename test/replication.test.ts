import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ReplicationConfig } from '../src/storage/config.js'
import { missingReplicas, replicate, selectUnderReplicated } from '../src/storage/replication.js'

const baseConfig: ReplicationConfig = {
  enabled: true,
  factor: 3,
  ackQuorum: 2,
  requireQuorumOnUpload: false,
  requestTimeoutMs: 1000,
  repairEnabled: true,
  repairSchedule: '0 * * * * *',
  token: 'r'.repeat(64)
}

const targets = [
  { name: 'ipfs2', apiUrl: 'https://ipfs2.example' },
  { name: 'ipfs3', apiUrl: 'https://ipfs3.example' }
]

describe('replicate', () => {
  it('reports best effort storage when replication is disabled', async () => {
    const report = await replicate({
      cid: 'bafkrei1',
      targets,
      config: { ...baseConfig, enabled: false },
      token: baseConfig.token,
      request: async () => assert.fail('peers must not be contacted')
    })

    assert.equal(report.mode, 'best-effort')
    assert.equal(report.acknowledged, 1)
    assert.equal(report.satisfied, true)
  })

  it('counts the local copy towards the quorum', async () => {
    const report = await replicate({
      cid: 'bafkrei1',
      targets,
      config: baseConfig,
      token: baseConfig.token,
      request: async (target) => {
        if (target.name === 'ipfs3') {
          throw new Error('unreachable')
        }
      }
    })

    assert.equal(report.acknowledged, 2)
    assert.deepEqual(report.replicas, ['ipfs2'])
    assert.equal(report.satisfied, true)
  })

  it('reports an unsatisfied quorum when too few peers acknowledge', async () => {
    const report = await replicate({
      cid: 'bafkrei1',
      targets,
      config: baseConfig,
      token: baseConfig.token,
      request: async () => {
        throw new Error('unreachable')
      }
    })

    assert.equal(report.acknowledged, 1)
    assert.equal(report.satisfied, false)
    assert.deepEqual(
      report.attempts.map((attempt) => attempt.ok),
      [false, false]
    )
  })

  it('survives a node that is offline', async () => {
    const report = await replicate({
      cid: 'bafkrei1',
      targets,
      config: { ...baseConfig, factor: 2, ackQuorum: 1 },
      token: baseConfig.token,
      request: async (target) => {
        if (target.name === 'ipfs2') {
          throw new Error('connection refused')
        }
      }
    })

    assert.equal(report.satisfied, true)
    assert.deepEqual(report.replicas, ['ipfs3'])
  })
})

describe('under-replication detection', () => {
  it('counts the copies still missing, including the local one', () => {
    assert.equal(missingReplicas(baseConfig, []), 2)
    assert.equal(missingReplicas(baseConfig, ['ipfs2']), 1)
    assert.equal(missingReplicas(baseConfig, ['ipfs2', 'ipfs3']), 0)
  })

  it('selects only the files below the replication factor', () => {
    const records = [
      { cid: 'a', replicas: ['ipfs2', 'ipfs3'] },
      { cid: 'b', replicas: ['ipfs2'] },
      { cid: 'c', replicas: [] }
    ]

    assert.deepEqual(
      selectUnderReplicated(records, baseConfig).map((item) => item.cid),
      ['b', 'c']
    )
  })
})
