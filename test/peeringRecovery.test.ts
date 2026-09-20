import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dropUnhealthyConnectedPeers } from '../src/peering/dropUnhealthyPeers.js'
import { createInFlightPass } from '../src/peering/inFlightPass.js'
import { PEER_PING_TIMEOUT_MS } from '../src/peering/liveness.js'
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
  })

  it('ignores unrelated errors', () => {
    assert.equal(isStalePeerSessionError('Not authorized'), false)
    assert.equal(isStalePeerSessionError('No room for another copy'), false)
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
})

async function waitForRecovery(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.fail('peer session recovery did not finish')
}

describe('recoverPeerSession', () => {
  it('ignores unknown peers and enforces cooldown', async () => {
    resetPeerSessionRecoveryStateForTests()
    let now = 1_000
    const calls = { ping: 0, reset: 0, redial: 0 }

    const actions = {
      isConfiguredPeer: (peerId: string) => peerId === 'known-peer',
      ping: async () => {
        calls.ping += 1
        return false
      },
      reset: async () => {
        calls.reset += 1
      },
      redial: async () => {
        calls.redial += 1
      },
      now: () => now
    }

    recoverPeerSession('unknown-peer', 'test', actions)
    recoverPeerSession('known-peer', 'first', actions)
    await waitForRecovery(() => calls.redial >= 1)
    assert.equal(calls.ping, 1)
    assert.equal(calls.reset, 1)
    assert.equal(calls.redial, 1)

    now += RECOVERY_COOLDOWN_MS - 1
    recoverPeerSession('known-peer', 'cooldown', actions)
    await waitForRecovery(() => calls.redial >= 1)
    assert.equal(calls.ping, 1)

    now += 1
    recoverPeerSession('known-peer', 'after cooldown', actions)
    await waitForRecovery(() => calls.redial >= 2)
    assert.equal(calls.ping, 2)
  })

  it('skips reset when ping succeeds', async () => {
    resetPeerSessionRecoveryStateForTests()
    const calls = { reset: 0, redial: 0, ping: 0 }

    recoverPeerSession('known-peer', 'healthy', {
      isConfiguredPeer: () => true,
      ping: async () => {
        calls.ping += 1
        return true
      },
      reset: async () => {
        calls.reset += 1
      },
      redial: async () => {
        calls.redial += 1
      },
      now: Date.now
    })

    await waitForRecovery(() => calls.ping >= 1)
    assert.equal(calls.reset, 0)
    assert.equal(calls.redial, 0)
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
})

describe('pingPeer timeout constant', () => {
  it('uses a bounded ping timeout', () => {
    assert.equal(PEER_PING_TIMEOUT_MS, 5000)
  })
})
