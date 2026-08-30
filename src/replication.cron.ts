import { CronJob } from 'cron'
import { config } from './config.js'
import { REPLICATION_PROTOCOL } from './storage/replicationProtocol.js'
import { repairReplication, type RepairReport } from './storage/service.js'
import { logger } from './utils/logger.js'
import { datastore } from './store.js'
import { Key } from 'interface-datastore'
import { createHash } from 'node:crypto'
import { membershipVersion } from './health/membership.js'

let running = false
let lastReport: RepairReport | null = null
const REPAIR_STATE_KEY = new Key('/adm/health/repair-cycle')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface RepairCycleEvidence {
  membershipVersion: string
  policyVersion: string
  cursor?: string
  startedAt: number
  checked: number
  underReplicated: number
  repaired: number
  stillMissing: number
  unrecoverable: number
  lastCompletedAt: number | null
  lastCompletedSuccessfully: boolean
}

let evidence: RepairCycleEvidence | null = null

function currentPolicyVersion(): string {
  return createHash('sha256').update(JSON.stringify(config.replication.placement)).digest('hex')
}

function emptyEvidence(now = Date.now()): RepairCycleEvidence {
  return {
    membershipVersion: membershipVersion(config.nodes),
    policyVersion: currentPolicyVersion(),
    startedAt: now,
    checked: 0,
    underReplicated: 0,
    repaired: 0,
    stillMissing: 0,
    unrecoverable: 0,
    lastCompletedAt: config.replication.enabled && config.replication.repairEnabled ? null : now,
    lastCompletedSuccessfully: !config.replication.enabled || !config.replication.repairEnabled
  }
}

async function loadEvidence(): Promise<RepairCycleEvidence> {
  if (evidence !== null) return evidence

  try {
    const stored = await datastore.get(REPAIR_STATE_KEY)
    let parsed: Partial<RepairCycleEvidence>
    try {
      parsed = JSON.parse(decoder.decode(stored)) as Partial<RepairCycleEvidence>
    } catch {
      logger.warn('Ignoring malformed persisted repair-cycle evidence')
      parsed = {}
    }
    evidence =
      typeof parsed.membershipVersion === 'string' &&
      typeof parsed.policyVersion === 'string' &&
      (parsed.cursor === undefined || typeof parsed.cursor === 'string') &&
      Number.isSafeInteger(parsed.startedAt) &&
      Number.isSafeInteger(parsed.checked) &&
      Number.isSafeInteger(parsed.underReplicated) &&
      Number.isSafeInteger(parsed.repaired) &&
      Number.isSafeInteger(parsed.stillMissing) &&
      Number.isSafeInteger(parsed.unrecoverable) &&
      (parsed.lastCompletedAt === null || Number.isSafeInteger(parsed.lastCompletedAt)) &&
      typeof parsed.lastCompletedSuccessfully === 'boolean'
        ? (parsed as RepairCycleEvidence)
        : emptyEvidence()
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_NOT_FOUND') throw err
    evidence = emptyEvidence()
  }

  if (
    evidence.membershipVersion !== membershipVersion(config.nodes) ||
    evidence.policyVersion !== currentPolicyVersion()
  ) {
    evidence = emptyEvidence()
  }

  return evidence
}

async function saveEvidence(value: RepairCycleEvidence): Promise<void> {
  await datastore.put(REPAIR_STATE_KEY, encoder.encode(JSON.stringify(value)))
  evidence = value
}

export class ReplicationRepairBusyError extends Error {
  constructor() {
    super('Replication repair is already running')
    this.name = 'ReplicationRepairBusyError'
  }
}

/**
 * Detect under-replicated durable content and push the missing copies.
 * Runs one pass at a time; a pass that is still working skips the next tick.
 */
export async function repairUnderReplicatedFiles(): Promise<RepairReport> {
  if (running) {
    throw new ReplicationRepairBusyError()
  }

  running = true
  try {
    const current = await loadEvidence()
    lastReport = await repairReplication({ cursor: current.cursor })

    const aggregate = {
      checked: current.checked + lastReport.checked,
      underReplicated: current.underReplicated + lastReport.underReplicated,
      repaired: current.repaired + lastReport.repaired.length,
      stillMissing: current.stillMissing + lastReport.stillMissing.length,
      unrecoverable: current.unrecoverable + lastReport.unrecoverable.length
    }
    const completedAt = lastReport.cycleCompleted ? Date.now() : current.lastCompletedAt
    const completedSuccessfully = lastReport.cycleCompleted
      ? aggregate.stillMissing === 0 && aggregate.unrecoverable === 0
      : current.lastCompletedSuccessfully

    await saveEvidence(
      lastReport.cycleCompleted
        ? {
            ...emptyEvidence(),
            lastCompletedAt: completedAt,
            lastCompletedSuccessfully: completedSuccessfully
          }
        : {
            ...current,
            cursor: lastReport.nextCursor,
            ...aggregate
          }
    )

    if (lastReport.underReplicated > 0) {
      logger.info(
        `Replication repair: ${lastReport.repaired.length} of ${lastReport.underReplicated} ` +
          'under-replicated files restored'
      )
    }

    return lastReport
  } finally {
    running = false
  }
}

export const replicationRepairCron = new CronJob(config.replication.repairSchedule, () => {
  if (running) {
    return
  }

  logger.info('[Cron] Running "replicationRepair" cronjob.')
  repairUnderReplicatedFiles().catch((err) => logger.error(`${err.message}\n${err.stack}`))
})

export function getReplicationState() {
  return {
    enabled: config.replication.enabled,
    // Shown so a mixed deployment is visible: nodes on different protocol
    // versions cannot place copies on each other.
    protocol: REPLICATION_PROTOCOL,
    placement: config.replication.placement,
    ackQuorum: config.replication.ackQuorum,
    requireQuorumOnUpload: config.replication.requireQuorumOnUpload,
    repairEnabled: config.replication.repairEnabled,
    repairSchedule: config.replication.repairSchedule,
    running,
    cycle: evidence
      ? {
          startedAt: evidence.startedAt,
          checked: evidence.checked,
          underReplicated: evidence.underReplicated,
          repaired: evidence.repaired,
          stillMissing: evidence.stillMissing,
          unrecoverable: evidence.unrecoverable,
          lastCompletedAt: evidence.lastCompletedAt,
          lastCompletedSuccessfully: evidence.lastCompletedSuccessfully
        }
      : null,
    lastRun: lastReport
      ? {
          checked: lastReport.checked,
          underReplicated: lastReport.underReplicated,
          repaired: lastReport.repaired.length,
          stillMissing: lastReport.stillMissing.length,
          rescued: lastReport.rescued.length,
          unrecoverable: lastReport.unrecoverable.length
        }
      : null
  }
}

/** Restore repair evidence before the first health checkpoint is evaluated. */
export async function initializeReplicationRepairState(): Promise<void> {
  await loadEvidence()
}

/** Last successful complete repair cycle used by the health checkpoint. */
export function getRepairHealthEvidence(): {
  required: boolean
  completedAt: number | null
} {
  const required = config.replication.enabled && config.replication.repairEnabled
  return {
    required,
    completedAt:
      !required || evidence?.lastCompletedSuccessfully === true
        ? (evidence?.lastCompletedAt ?? Date.now())
        : null
  }
}
