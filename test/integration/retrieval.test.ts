import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { unixfs, type UnixFS } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import type { CID } from 'multiformats/cid'
import { createIpfsNode, type IpfsNode } from '../../src/ipfs-node.js'
import type { ReplicationPeer } from '../../src/storage/replication.js'
import { connectToHolders } from '../../src/storage/retrieval.js'
import { deterministicBytes } from '../fixtures.js'

/** Only loopback, and port 0 so the OS picks a free port. */
const LISTEN = ['/ip4/127.0.0.1/tcp/0']

interface TestNode {
  node: IpfsNode
  blockstore: FsBlockstore
  datastore: FsDatastore
  dir: string
}

async function startNode(): Promise<TestNode> {
  const dir = await mkdtemp(join(tmpdir(), 'ipfs-node-retrieval-'))
  const blockstore = new FsBlockstore(join(dir, 'blockstore'))
  const datastore = new FsDatastore(join(dir, 'datastore'))
  await blockstore.open()
  await datastore.open()

  return {
    node: await createIpfsNode({ blockstore, datastore, listen: LISTEN }),
    blockstore,
    datastore,
    dir
  }
}

async function stopNode(testNode: TestNode): Promise<void> {
  await testNode.node.stop()
  await testNode.blockstore.close()
  await testNode.datastore.close()
  await rm(testNode.dir, { recursive: true, force: true })
}

/** Read a file with a deadline, reporting whether it arrived. */
async function canRead(fs: UnixFS, cid: CID, timeoutMs: number): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    let total = 0
    for await (const chunk of fs.cat(cid, { signal })) {
      total += chunk.byteLength
    }
    return total > 0
  } catch {
    return false
  }
}

let holder: TestNode
let reader: TestNode
let holderFs: UnixFS
let readerFs: UnixFS

before(async () => {
  holder = await startNode()
  reader = await startNode()
  holderFs = unixfs(holder.node)
  readerFs = unixfs(reader.node)
})

after(async () => {
  await stopNode(reader)
  await stopNode(holder)
})

describe('retrieval from an unconnected holder', () => {
  it('cannot read the file while no connection exists', async () => {
    const cid = await holderFs.addBytes(deterministicBytes(2048, 'unreachable'))

    assert.equal(reader.node.libp2p.getPeers().length, 0)
    assert.equal(await canRead(readerFs, cid, 1500), false)
  })

  it('reads the file after connecting to the node that holds it', async () => {
    const cid = await holderFs.addBytes(deterministicBytes(2048, 'reachable'))
    const target: ReplicationPeer = {
      name: 'holder',
      peerId: holder.node.libp2p.peerId.toString(),
      multiAddr: holder.node.libp2p.getMultiaddrs()[0]
    }

    assert.equal(await canRead(readerFs, cid, 1500), false)

    const opened = await connectToHolders(reader.node, [target])
    assert.equal(opened, 1)

    assert.equal(await canRead(readerFs, cid, 10000), true)
  })

  it('opens nothing when the holder is already connected', async () => {
    const target: ReplicationPeer = {
      name: 'holder',
      peerId: holder.node.libp2p.peerId.toString(),
      multiAddr: holder.node.libp2p.getMultiaddrs()[0]
    }

    assert.equal(await connectToHolders(reader.node, [target]), 0)
  })

  it('ignores a peer it cannot reach', async () => {
    const unreachable: ReplicationPeer = {
      name: 'gone',
      peerId: '12D3KooWJw99nqrQ2L2joFuGCF9EN9EyF8ZrvGr1odQ61HoPrbXd',
      multiAddr: holder.node.libp2p.getMultiaddrs()[0]
    }

    await assert.doesNotReject(() => connectToHolders(reader.node, [unreachable], 1000))
  })
})
