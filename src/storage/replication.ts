import type { ReplicationConfig } from './config.js'

export type ReplicationTarget = {
  name: string
  apiUrl: string
}

export type ReplicationAck = {
  node: string
  ok: boolean
  error?: string
}

export type ReplicationReport = {
  /**
   * `quorum` when the node actively pushes copies to its peers,
   * `best-effort` when replication is disabled and durability is local only.
   */
  mode: 'quorum' | 'best-effort'
  /** Copies the policy requires, including the copy on this node */
  factor: number
  /** Acknowledgements the policy requires before an upload is durable */
  required: number
  /** Copies confirmed right now, including the copy on this node */
  acknowledged: number
  /** Peer nodes that acknowledged holding a copy */
  replicas: string[]
  satisfied: boolean
  attempts: ReplicationAck[]
}

export type ReplicateOptions = {
  cid: string
  targets: ReplicationTarget[]
  config: ReplicationConfig
  token: string
  /** Injected for tests; defaults to the global fetch */
  request?: (target: ReplicationTarget, cid: string) => Promise<void>
}

/**
 * Ask a peer node to store a copy of the content.
 *
 * The peer pulls the DAG over libp2p and pins it, so a successful response
 * means the copy exists and is protected, not merely that the request arrived.
 */
async function pushToPeer(
  target: ReplicationTarget,
  cid: string,
  config: ReplicationConfig,
  token: string
): Promise<void> {
  const url = `${target.apiUrl.replace(/\/+$/, '')}/api/replication/${cid}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-replication-token': token,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })

  if (!response.ok) {
    throw new Error(`${target.name} responded with HTTP ${response.status}`)
  }
}

/**
 * Replicate content across the configured ADAMANT nodes and report whether the
 * acknowledgement quorum was reached.
 *
 * When replication is disabled the node reports `best-effort`: the content is
 * stored and pinned locally, and no durability claim is made beyond that.
 */
export async function replicate(options: ReplicateOptions): Promise<ReplicationReport> {
  const { config, cid } = options

  if (!config.enabled) {
    return {
      mode: 'best-effort',
      factor: 1,
      required: 1,
      acknowledged: 1,
      replicas: [],
      satisfied: true,
      attempts: []
    }
  }

  const request = options.request ?? ((target) => pushToPeer(target, cid, config, options.token))

  const attempts = await Promise.all(
    options.targets.map(async (target): Promise<ReplicationAck> => {
      try {
        await request(target, cid)
        return { node: target.name, ok: true }
      } catch (err) {
        return { node: target.name, ok: false, error: (err as Error).message }
      }
    })
  )

  const replicas = attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.node)
  // The local copy counts towards the quorum: it is pinned before peers are asked.
  const acknowledged = replicas.length + 1

  return {
    mode: 'quorum',
    factor: config.factor,
    required: config.ackQuorum,
    acknowledged,
    replicas,
    satisfied: acknowledged >= config.ackQuorum,
    attempts
  }
}

/**
 * Copies still missing for a file, given the peers that already acknowledged.
 * The local copy is always counted, so the result is what repair must create.
 */
export function missingReplicas(config: ReplicationConfig, replicas: string[]): number {
  return Math.max(0, config.factor - (replicas.length + 1))
}

/** Files that hold fewer copies than the replication factor requires. */
export function selectUnderReplicated<T extends { cid: string; replicas: string[] }>(
  records: T[],
  config: ReplicationConfig
): T[] {
  return records.filter((record) => missingReplicas(config, record.replicas) > 0)
}
