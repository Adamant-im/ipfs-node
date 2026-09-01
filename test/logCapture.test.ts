import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { createApplicationLogger } from '../src/utils/logger.js'

const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const PEER_ID = '12D3KooWSUCe86zWfas1Lo1UQzXzquZgS81d1DpPPYAuTNjSyniq'
const MULTIADDR = `/ip4/194.163.154.252/tcp/4001/p2p/${PEER_ID}`

/** Collect what the wired logger actually writes, not what a call site intended. */
function capture(): { logger: ReturnType<typeof createApplicationLogger>; lines: () => string } {
  let written = ''
  const destination = new Writable({
    write(chunk, unusedEncoding, done) {
      written += String(chunk)
      done()
    }
  })

  return {
    logger: createApplicationLogger({ level: 'debug', destination }),
    lines: () => written
  }
}

describe('application log sanitization', () => {
  it('keeps content identifiers out of a template message', () => {
    const { logger, lines } = capture()

    logger.info(`No configured node reports holding ${CID_V1}`)
    logger.warn(`No node was holding ${CID_V0}; kept the local copy instead`)

    const output = lines()
    assert.equal(output.includes(CID_V1), false)
    assert.equal(output.includes(CID_V0), false)
    assert.equal(output.includes('[cid]'), true)
    // The operational meaning of the message survives the scrub.
    assert.equal(output.includes('kept the local copy instead'), true)
  })

  it('covers CID forms a length threshold would miss', () => {
    const { logger, lines } = capture()
    // Valid CIDv1 with an identity multihash: 32 characters, well under the
    // length of the common sha2-256 form.
    const shortCid = 'bafkqad3qojuxmylumuqhaylznrxwcza'

    logger.error(`Cannot pin ${shortCid}`)

    const output = lines()
    assert.equal(output.includes(shortCid), false)
    assert.equal(output.includes('[cid]'), true)
  })

  it('keeps peer identities and multiaddrs out of a message', () => {
    const { logger, lines } = capture()

    logger.info(`Helia is running! PeerID: ${PEER_ID}`)
    logger.info(`Start peering ipfs1 node (${MULTIADDR})...`)

    const output = lines()
    assert.equal(output.includes(PEER_ID), false)
    assert.equal(output.includes('194.163.154.252'), false)
    assert.equal(output.includes('[peer]'), true)
    assert.equal(output.includes('[multiaddr]'), true)
  })

  it('scrubs structured fields, not only the message', () => {
    const { logger, lines } = capture()

    logger.info({ event: 'replication_repair_pass', cursor: CID_V1, peers: [PEER_ID] }, 'pass')

    const output = lines()
    assert.equal(output.includes(CID_V1), false)
    assert.equal(output.includes(PEER_ID), false)
    assert.equal(output.includes('replication_repair_pass'), true)
  })

  it('reports an error without its stack', () => {
    const { logger, lines } = capture()
    const failure = Object.assign(new Error(`Cannot pin ${CID_V1}`), { code: 'ERR_NOT_FOUND' })

    logger.error({ err: failure }, 'Repair pass failed')
    logger.error(failure)

    const output = lines()
    assert.equal(output.includes('    at '), false)
    assert.equal(output.includes(CID_V1), false)
    assert.equal(output.includes('ERR_NOT_FOUND'), true)
    assert.equal(output.includes('Repair pass failed'), true)
  })

  it('drops a stack that reached the message as text', () => {
    const { logger, lines } = capture()

    logger.error(`Scan failed: boom\n    at scan (/srv/ipfs-node/dist/scan.js:12:9)`)

    const output = lines()
    assert.equal(output.includes('    at scan'), false)
    assert.equal(output.includes('[stack omitted]'), true)
    assert.equal(output.includes('Scan failed: boom'), true)
  })

  it('leaves ordinary operational text alone', () => {
    const { logger, lines } = capture()

    logger.info('Upload request carries 3 file(s)')
    logger.info({ event: 'storage_demoted_record', holders: 2 }, 'Released a local copy')

    const output = lines()
    assert.equal(output.includes('Upload request carries 3 file(s)'), true)
    assert.equal(output.includes('"holders":2'), true)
    assert.equal(output.includes('[cid]'), false)
  })
})
