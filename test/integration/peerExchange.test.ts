import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { CID } from 'multiformats/cid'
import { createIpfsNode, createUnixFs, type IpfsNode } from '../../src/ipfs-node.js'
import { README_FIXTURE, deterministicBytes } from '../fixtures.js'

/** Only loopback, and port 0 so the OS picks a free port. */
const LISTEN = ['/ip4/127.0.0.1/tcp/0']

interface TestNode {
  node: IpfsNode
  blockstore: FsBlockstore
  datastore: FsDatastore
}

/**
 * Start a node backed by a throwaway on-disk store.
 *
 * @param dir Store directory; pass an existing one to restart a node with its
 *            previous identity
 * @param bootstrap Multiaddrs to dial on startup
 */
async function startNode(dir: string, bootstrap: string[] = []): Promise<TestNode> {
  const blockstore = new FsBlockstore(join(dir, 'blockstore'))
  const datastore = new FsDatastore(join(dir, 'datastore'))
  await blockstore.open()
  await datastore.open()

  const node = await createIpfsNode({ blockstore, datastore, listen: LISTEN, bootstrap })

  return { node, blockstore, datastore }
}

async function stopNode(testNode: TestNode): Promise<void> {
  await testNode.node.stop()
  await testNode.blockstore.close()
  await testNode.datastore.close()
}

let dirA: string
let dirB: string
let nodeA: TestNode
let nodeB: TestNode

before(async () => {
  dirA = await mkdtemp(join(tmpdir(), 'ipfs-node-a-'))
  dirB = await mkdtemp(join(tmpdir(), 'ipfs-node-b-'))

  nodeA = await startNode(dirA)
  nodeB = await startNode(dirB)

  // Connect B to A directly; the ADAMANT topology relies on known peers only
  await nodeB.node.libp2p.dial(nodeA.node.libp2p.getMultiaddrs())
})

after(async () => {
  await stopNode(nodeB)
  await stopNode(nodeA)
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

describe('two isolated nodes', () => {
  it('start with distinct peer ids', () => {
    assert.notEqual(nodeA.node.libp2p.peerId.toString(), nodeB.node.libp2p.peerId.toString())
    assert.equal(nodeA.node.status, 'started')
    assert.equal(nodeB.node.status, 'started')
  })

  it('register only the identify and ping services', () => {
    assert.deepEqual(Object.keys(nodeA.node.libp2p.services).sort(), ['identify', 'ping'])
  })

  it('are connected to each other', () => {
    const peers = nodeB.node.libp2p.getPeers().map((peer) => peer.toString())

    assert.ok(peers.includes(nodeA.node.libp2p.peerId.toString()))
  })

  it('answer the ping service used by GET /api/libp2p/services/ping', async () => {
    const rtt = await nodeB.node.libp2p.services.ping.ping(nodeA.node.libp2p.peerId)

    assert.equal(typeof rtt, 'number')
    assert.ok(rtt >= 0)
  })

  it('expose JSON-serialisable connection data for GET /api/libp2p/connections', () => {
    const [connection] = nodeB.node.libp2p.getConnections()

    assert.ok(connection)
    assert.equal(connection.multiplexer, '/yamux/1.0.0')
    assert.equal(connection.encryption, '/noise')
    assert.equal(connection.remotePeer.toString(), nodeA.node.libp2p.peerId.toString())
  })
})

describe('file exchange between known peers', () => {
  it('a file uploaded to node A is retrievable from node B', async () => {
    const ifsA = createUnixFs(nodeA.node)
    const ifsB = createUnixFs(nodeB.node)

    const content = deterministicBytes(3145735, 'd')
    const cid = await ifsA.addByteStream(Readable.from(content))
    for await (const _pinned of nodeA.node.pins.add(cid)) {
      // draining the generator performs the pin
    }

    // Node B has none of these blocks locally; they must come from node A
    const localOnly = ifsB.cat(cid, { offline: true })
    await assert.rejects(async () => {
      for await (const _chunk of localOnly) {
        // draining is enough to trigger the local lookup
      }
    })

    const chunks: Uint8Array[] = []
    for await (const chunk of ifsB.cat(cid, { signal: AbortSignal.timeout(30_000) })) {
      chunks.push(chunk)
    }

    assert.deepEqual(Buffer.concat(chunks), content)
  })

  it('a transferred file keeps its pre-migration CID', async () => {
    const ifsA = createUnixFs(nodeA.node)
    const ifsB = createUnixFs(nodeB.node)

    const cid = await ifsA.addByteStream(Readable.from(README_FIXTURE.content))
    assert.equal(cid.toString(), README_FIXTURE.cid)

    const chunks: Uint8Array[] = []
    for await (const chunk of ifsB.cat(CID.parse(README_FIXTURE.cid), {
      signal: AbortSignal.timeout(30_000)
    })) {
      chunks.push(chunk)
    }

    assert.deepEqual(Buffer.concat(chunks), README_FIXTURE.content)
  })
})

describe('peer identity', () => {
  it('is stable across a restart with the same store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-restart-'))

    try {
      const first = await startNode(dir)
      const firstPeerId = first.node.libp2p.peerId.toString()
      await stopNode(first)

      const second = await startNode(dir)
      const secondPeerId = second.node.libp2p.peerId.toString()
      await stopNode(second)

      assert.equal(secondPeerId, firstPeerId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
