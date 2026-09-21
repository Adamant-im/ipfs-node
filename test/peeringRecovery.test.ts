import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dropUnhealthyConnectedPeers } from '../src/peering/dropUnhealthyPeers.js'
import { createInFlightPass } from '../src/peering/inFlightPass.js'
import { PEER_PING_TIMEOUT_MS, pingPeer } from '../src/peering/liveness.js'
import {
  RECOVERY_COOLDOWN_MS,
  recoverPeerSession,
  resetPeerSessionRecoveryStateForTests
} from '../src/peering/peerSessionRecovery.js'
import { isStalePeerSessionError } from '../src/peering/staleSessionErrors.js'

describe('isStalePeerSessionError', () => {
  it('matches replication stream failures seen on testnet', () => {
    assert.equal(
      isStalePeerSessionError(
        'Replication request failed: Cannot write to a stream that is closed'
      ),
      true
    )
    assert.equal(
      isStalePeerSessionError(
        'Replication request failed: Replication stream ended before a complete message arrived'
      ),
      true
    )
    assert.equal(isStalePeerSessionError('Replication request timed out'), true)
    assert.equal(isStalePeerSessionError('Replication message timed out'), true)
    assert.equal(
      isStalePeerSessionError('Replication request failed: Replication message timed out'),
      true
    )
    assert.equal(isStalePeerSessionError('The connection is closed'), true)
    assert.equal(isStalePeerSessionError('The stream has been reset'), true)
    assert.equal(isStalePeerSessionError('stream has been reset'), true)
    assert.equal(isStalePeerSessionError('stream reset'), true)
    assert.equal(isStalePeerSessionError('connection reset'), true)
    assert.equal(isStalePeerSessionError('read ECONNRESET'), true)
    assert.equal(isStalePeerSessionError('write EPIPE'), true)
  })

  it('ignores unrelated errors', () => {
    assert.equal(isStalePeerSessionError('Not authorized'), false)
    assert.equal(isStalePeerSessionError('No room for another copy'), false)
    assert.equal(
      isStalePeerSessionError('Health stream ended before a complete message arrived'),
      false
    )
  })
})

describe('dropUnhealthyConnectedPeers', () => {
  it('keeps healthy peers and resets peers that fail ping', async () => {
    const peerA = { toString: () => 'peer-a' } as never
    const peerB = { toString: () => 'peer-b' } as never
    const connected = new Set(['peer-a', 'peer-b'])
    const pinged: string[] = []
    const reset: string[] = []

    const node = {
      libp2p: {
        services: {
          ping: {
            ping: async (peerId: { toString: () => string }) => {
              pinged.push(peerId.toString())
              if (peerId.toString() === 'peer-a') {
                return 1
              }

              throw new Error('ping failed')
            }
          }
        },
        hangUp: async (peerId: { toString: () => string }) => {
          reset.push(peerId.toString())
        }
      }
    }

    const resetPeerIds = await dropUnhealthyConnectedPeers(node as never, [peerA, peerB], connected)

    assert.deepEqual(pinged.sort(), ['peer-a', 'peer-b'])
    assert.deepEqual(reset, ['peer-b'])
    assert.deepEqual(resetPeerIds, ['peer-b'])
  })

  it('does not ping configured peers that are not connected', async () => {
    const peerA = { toString: () => 'peer-a' } as never
    const pinged: string[] = []
    const node = {
      libp2p: {
        services: {
          ping: {
            ping: async (peerId: { toString: () => string }) => {
              pinged.push(peerId.toString())
              return 1
            }
          }
        },
        hangUp: async () => {}
      }
    }

    const resetPeerIds = await dropUnhealthyConnectedPeers(node as never, [peerA], new Set())

    assert.deepEqual(pinged, [])
    assert.deepEqual(resetPeerIds, [])
  })
})

describe('recoverPeerSession', () => {
  it('ignores unknown peers and enforces cooldown', async () => {
    resetPeerSessionRecoveryStateForTests()
    let now = 1_000
    const calls = { reset: 0, redial: 0 }

    const actions = {
      isConfiguredPeer: (peerId: string) => peerId === 'known-peer',
      reset: async () => {
        calls.reset += 1
      },
      redial: async () => {
        calls.redial += 1
      },
      now: () => now
    }

    await recoverPeerSession('unknown-peer', 'test', actions)
    await recoverPeerSession('known-peer', 'first', actions)
    assert.equal(calls.reset, 1)
    assert.equal(calls.redial, 1)

    now += RECOVERY_COOLDOWN_MS - 1
    await recoverPeerSession('known-peer', 'cooldown', actions)
    assert.equal(calls.reset, 1)

    now += 1
    await recoverPeerSession('known-peer', 'after cooldown', actions)
    assert.equal(calls.reset, 2)
    assert.equal(calls.redial, 2)
  })

  it('hangs up without waiting on ping', async () => {
    resetPeerSessionRecoveryStateForTests()
    const calls = { reset: 0, redial: 0 }

    await recoverPeerSession('known-peer', 'replication stream ended', {
      isConfiguredPeer: () => true,
      reset: async () => {
        calls.reset += 1
      },
      redial: async () => {
        calls.redial += 1
      },
      now: Date.now
    })

    assert.equal(calls.reset, 1)
    assert.equal(calls.redial, 1)
  })

  it('coalesces concurrent recovery attempts for the same peer', async () => {
    resetPeerSessionRecoveryStateForTests()
    let resetStarted = 0
    let resetDone = 0

    const actions = {
      isConfiguredPeer: () => true,
      reset: async () => {
        resetStarted += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        resetDone += 1
      },
      redial: async () => {},
      now: Date.now
    }

    const [first, second] = await Promise.all([
      recoverPeerSession('peer-1', 'reason 1', actions),
      recoverPeerSession('peer-1', 'reason 2', actions)
    ])

    assert.equal(first, true)
    assert.equal(second, true)
    assert.equal(resetStarted, 1)
    assert.equal(resetDone, 1)
  })
})

describe('createInFlightPass', () => {
  it('shares one in-flight promise between concurrent callers', async () => {
    const runPass = createInFlightPass<number>()
    let runs = 0

    const task = async () => {
      runs += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return runs
    }

    const [first, second] = await Promise.all([runPass(task), runPass(task)])
    assert.equal(first, 1)
    assert.equal(second, 1)
    assert.equal(runs, 1)
  })

  it('runs a new pass after the previous one finishes', async () => {
    const runPass = createInFlightPass<number>()
    let runs = 0
    const task = async () => {
      runs += 1
      return runs
    }

    assert.equal(await runPass(task), 1)
    assert.equal(await runPass(task), 2)
  })
})

describe('pingPeer', () => {
  it('uses a bounded ping timeout', () => {
    assert.equal(PEER_PING_TIMEOUT_MS, 5000)
  })

  it('returns false when ping does not settle before the timeout', async () => {
    const node = {
      libp2p: {
        services: {
          ping: {
            ping: async (_peerId: unknown, options?: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  reject(new Error('aborted'))
                })
              })
          }
        }
      }
    }

    const startedAt = Date.now()
    const alive = await pingPeer(node as never, { toString: () => 'peer-a' } as never, 20)

    assert.equal(alive, false)
    assert.equal(Date.now() - startedAt < 500, true)
  })

  it('coalesces concurrent ping requests for the same peer', async () => {
    let rawPings = 0
    const node = {
      libp2p: {
        services: {
          ping: {
            ping: async () => {
              rawPings += 1
              await new Promise((resolve) => setTimeout(resolve, 20))
              return 42
            }
          }
        }
      }
    }

    const peerId = { toString: () => 'coalesced-peer' } as never
    const [alive1, alive2] = await Promise.all([
      pingPeer(node as never, peerId),
      pingPeer(node as never, peerId)
    ])

    assert.equal(alive1, true)
    assert.equal(alive2, true)
    assert.equal(rawPings, 1)
  })
})
