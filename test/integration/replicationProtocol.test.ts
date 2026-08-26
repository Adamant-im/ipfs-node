import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { CID } from 'multiformats/cid'
import { createIpfsNode, type IpfsNode } from '../../src/ipfs-node.js'
import { isDirectlyPinned, pinFile, unpinFile } from '../../src/storage/pinning.js'
import {
  probeAccept,
  probeHave,
  registerReplicationProtocol,
  requestAbort,
  requestCommit,
  requestStage,
  requestStore,
  type ReplicationHandlers
} from '../../src/storage/replicationProtocol.js'
import { deterministicBytes } from '../fixtures.js'

/** Only loopback, and port 0 so the OS picks a free port. */
const LISTEN = ['/ip4/127.0.0.1/tcp/0']
const CALL = { timeoutMs: 15000 }

interface TestNode {
  node: IpfsNode
  blockstore: FsBlockstore
  datastore: FsDatastore
  dir: string
}

async function startNode(): Promise<TestNode> {
  const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-repl-'))
  const blockstore = new FsBlockstore(join(dir, 'blockstore'))
  const datastore = new FsDatastore(join(dir, 'datastore'))
  await blockstore.open()
  await datastore.open()

  const node = await createIpfsNode({ blockstore, datastore, listen: LISTEN })

  return { node, blockstore, datastore, dir }
}

async function stopNode(testNode: TestNode): Promise<void> {
  await testNode.node.stop()
  await testNode.blockstore.close()
  await testNode.datastore.close()
  await rm(testNode.dir, { recursive: true, force: true })
}

let sender: TestNode
let holder: TestNode
let senderFs: UnixFS
let holderFs: UnixFS
let authorized: Set<string>
let refusals: string[]
let hasRoom = true
let committed: string[]
let aborted: string[]

before(async () => {
  sender = await startNode()
  holder = await startNode()
  senderFs = unixfs(sender.node)
  holderFs = unixfs(holder.node)

  authorized = new Set([sender.node.libp2p.peerId.toString()])
  refusals = []
  committed = []
  aborted = []

  const handlers: ReplicationHandlers = {
    isAuthorized: (peerId) => authorized.has(peerId),
    store: async (cid) => {
      await pinFile(holder.node, CID.parse(cid), AbortSignal.timeout(CALL.timeoutMs))
      const stats = await holderFs.stat(CID.parse(cid), { extended: true, offline: true })
      return Number(stats.deduplicatedDagSize)
    },
    stage: async (cid) => {
      await pinFile(holder.node, CID.parse(cid), AbortSignal.timeout(CALL.timeoutMs))
      const stats = await holderFs.stat(CID.parse(cid), { extended: true, offline: true })
      return { storedBytes: Number(stats.deduplicatedDagSize), staged: true }
    },
    commit: async (cid, transactionId) => {
      committed.push(`${cid}:${transactionId}`)
    },
    abort: async (cid, transactionId) => {
      aborted.push(`${cid}:${transactionId}`)
      await unpinFile(holder.node, CID.parse(cid))
    },
    have: async (cid) => isDirectlyPinned(holder.node, CID.parse(cid)),
    willAccept: async () => hasRoom,
    cacheCopy: async (cid) => {
      let bytes = 0
      for await (const chunk of holderFs.cat(CID.parse(cid))) {
        bytes += chunk.byteLength
      }
      return bytes
    },
    onError: (message) => refusals.push(message)
  }

  await registerReplicationProtocol(holder.node, handlers)

  // The holder pulls blocks over this connection, so it has to exist first
  await sender.node.libp2p.dial(holder.node.libp2p.getMultiaddrs())
})

after(async () => {
  await stopNode(sender)
  await stopNode(holder)
})

describe('replication over libp2p', () => {
  it('places a copy on a peer, which pins it before answering', async () => {
    const cid = await senderFs.addBytes(deterministicBytes(4096, 'placed'))

    const storedBytes = await requestStore(
      sender.node,
      holder.node.libp2p.getMultiaddrs()[0],
      cid.toString(),
      CALL
    )

    assert.ok(storedBytes > 0, 'the peer must report what it stored')
    assert.equal(await isDirectlyPinned(holder.node, cid), true)
    assert.equal(await holder.blockstore.has(cid), true)
  })

  it('carries a multi-block file in full', async () => {
    const content = deterministicBytes(3_145_735, 'placed-large')
    const cid = await senderFs.addBytes(content)

    await requestStore(sender.node, holder.node.libp2p.getMultiaddrs()[0], cid.toString(), CALL)

    const chunks: Uint8Array[] = []
    for await (const chunk of holderFs.cat(cid, { offline: true })) {
      chunks.push(chunk)
    }

    assert.deepEqual(Buffer.concat(chunks), content)
  })

  it('answers whether it holds a file', async () => {
    const held = await senderFs.addBytes(deterministicBytes(1024, 'probe-held'))
    const absent = await senderFs.addBytes(deterministicBytes(1024, 'probe-absent'))
    const peer = holder.node.libp2p.getMultiaddrs()[0]

    await requestStore(sender.node, peer, held.toString(), CALL)

    assert.equal(await probeHave(sender.node, peer, held.toString(), CALL), true)
    assert.equal(await probeHave(sender.node, peer, absent.toString(), CALL), false)
  })

  it('says whether it has room before anything is transferred', async () => {
    const cid = await senderFs.addBytes(deterministicBytes(1024, 'capacity'))
    const peer = holder.node.libp2p.getMultiaddrs()[0]

    assert.equal(await probeAccept(sender.node, peer, cid.toString(), CALL), true)

    hasRoom = false
    try {
      assert.equal(await probeAccept(sender.node, peer, cid.toString(), CALL), false)
      // The question is answered without the file moving anywhere
      assert.equal(await isDirectlyPinned(holder.node, cid), false)
    } finally {
      hasRoom = true
    }
  })

  it('refuses a peer that is not a known node', async () => {
    const cid = await senderFs.addBytes(deterministicBytes(1024, 'unauthorized'))
    const peer = holder.node.libp2p.getMultiaddrs()[0]

    authorized.clear()
    try {
      await assert.rejects(
        () => requestStore(sender.node, peer, cid.toString(), CALL),
        /Not authorized/
      )
      assert.equal(await isDirectlyPinned(holder.node, cid), false)
    } finally {
      authorized.add(sender.node.libp2p.peerId.toString())
    }
  })

  it('rejects a request for content no peer can serve', async () => {
    // A CID nobody holds; the holder cannot pull it and must fail, not hang
    const unknown = 'bafkreiapv3pyvtsdmvcqcgzvvjmayksybgcgfvkbfbbccjnisz3ndnvcam'

    await assert.rejects(() =>
      requestStore(sender.node, holder.node.libp2p.getMultiaddrs()[0], unknown, {
        timeoutMs: 2000
      })
    )
  })

  it('stages and settles a strict-upload copy with its transaction id', async () => {
    const commitCid = await senderFs.addBytes(deterministicBytes(1200, 'protocol-commit'))
    const abortCid = await senderFs.addBytes(deterministicBytes(1300, 'protocol-abort'))
    const peer = holder.node.libp2p.getMultiaddrs()[0]

    const preparedCommit = await requestStage(
      sender.node,
      peer,
      commitCid.toString(),
      'tx-commit',
      CALL
    )
    assert.equal(preparedCommit.staged, true)
    assert.equal(await isDirectlyPinned(holder.node, commitCid), true)

    await requestCommit(sender.node, peer, commitCid.toString(), 'tx-commit', CALL)
    assert.deepEqual(committed, [`${commitCid}:tx-commit`])

    await requestStage(sender.node, peer, abortCid.toString(), 'tx-abort', CALL)
    await requestAbort(sender.node, peer, abortCid.toString(), 'tx-abort', CALL)
    assert.deepEqual(aborted, [`${abortCid}:tx-abort`])
    assert.equal(await isDirectlyPinned(holder.node, abortCid), false)
  })
})
