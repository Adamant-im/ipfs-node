import { createHash } from 'node:crypto'

/**
 * Deterministic pseudo-random bytes.
 *
 * The generator is a SHA-256 chain seeded with `seed`, so the same seed and
 * length always produce the same bytes. This is what makes the recorded CIDs in
 * {@link CID_FIXTURES} reproducible.
 *
 * @param length Number of bytes to produce
 * @param seed Seed string mixed into the first hash
 */
export function deterministicBytes(length: number, seed: string): Buffer {
  const out = Buffer.alloc(length)
  let block = createHash('sha256').update(seed).digest()

  for (let offset = 0; offset < length; offset += 32) {
    block.copy(out, offset, 0, Math.min(32, length - offset))
    block = createHash('sha256').update(block).digest()
  }

  return out
}

export interface CidFixture {
  name: string
  length: number
  seed: string
  /** CID produced by the pre-migration stack (helia 4.2.6 / @helia/unixfs 3.0.7). */
  cid: string
}

/**
 * File CIDs recorded from the pre-migration stack.
 *
 * Sizes bracket the 1 MiB default chunk size so that both the single-block
 * (`raw`) and the multi-block (`dag-pb`) import paths are covered. `hello.txt`
 * is the example documented in `README.md`.
 */
export const CID_FIXTURES: CidFixture[] = [
  {
    name: 'empty.bin',
    length: 0,
    seed: 'empty',
    cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
  },
  {
    name: 'small.bin',
    length: 1024,
    seed: 'small',
    cid: 'bafkreihfzyt2g6pbd4rhk67deek7xh33xams74spn72eqq5qhx2ypphvii'
  },
  {
    name: 'unicode-файл.bin',
    length: 5000,
    seed: 'u',
    cid: 'bafkreig2ml3a53tagqpjbqbh7o6gr3rb2j4bvdbjiq3azpjp6yi7rzhzha'
  },
  {
    name: 'chunk-minus-1.bin',
    length: 1048575,
    seed: 'a',
    cid: 'bafkreibvqh3ms3gu3igry47phefzvsw3ebc2kgdw7ax5ulbb4vwtflcyme'
  },
  {
    name: 'chunk-exact.bin',
    length: 1048576,
    seed: 'b',
    cid: 'bafkreig3i63vhvjjvolfvk3cqi6hpmumwfn2cqvln7uqgvdynrr2h7l5x4'
  },
  {
    name: 'chunk-plus-1.bin',
    length: 1048577,
    seed: 'c',
    cid: 'bafybeiccwqpicdluy2i54utx2ao4eus3ngjkuput3rxqasdb7wqi5g5zvq'
  },
  {
    name: 'multi-chunk.bin',
    length: 3145735,
    seed: 'd',
    cid: 'bafybeifo32iadmp7eawlzbipy7s2k67774lumc7fb6yrtnjofylt2tuhgq'
  },
  {
    name: 'deep-dag.bin',
    length: 12582925,
    seed: 'e',
    cid: 'bafybeifc5mk2pihtuaksnact2orkabzuf3z4wtn7jwrm7e2d2scvkdkkhu'
  }
]

/** The `hello.txt` upload documented in `README.md`, with its published CID. */
export const README_FIXTURE = {
  name: 'hello.txt',
  content: Buffer.from('Hello ipfs-node!\n', 'utf8'),
  cid: 'bafkreif7v2d2wdyh6pz5y2pwmrpegfpdgh5u7n5vomxnbofraqhuk2wapm'
}
