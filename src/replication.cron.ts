import { CronJob } from 'cron'
import { config } from './config.js'
import { REPLICATION_PROTOCOL } from './storage/replicationProtocol.js'
import { repairReplication, type RepairReport } from './storage/service.js'
import { logger } from './utils/logger.js'
import { datastore } from './store.js'
import { Key } from 'interface-datastore'
import { createHash } from 'node:crypto'
import { membershipVersion } from './health/membership.js'
import { RepairCycleDriver, type RepairTrigger } from './storage/repairCycleDriver.js'
import { parseEvidence, type RepairCycleEvidence } from './storage/repairEvidence.js'

let running = false
let lastReport: RepairReport | null = null
const REPAIR_STATE_KEY = new Key('/adm/health/repair-cycle')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

let evidence: RepairCycleEvidence | null = null

function currentPolicyVersion(): string {
  return createHash('sha256').update(JSON.stringify(config.replication.placement)).digest('hex')
}

function emptyEvidence(now = Date.now()): RepairCycleEvidence {
  return {
    membershipVersion: membershipVersion(config.nodes),
    policyVersion: currentPolicyVersion(),
    startedAt: now,
    superseded: false,
    examined: 0,
    checked: 0,
    underReplicated: 0,
    repaired: 0,
    stillMissing: 0,
    unrecoverable: 0,
    lastCompletedAt: config.replication.enabled && config.replication.repairEnabled ? null : now,
    lastCompletedSuccessfully: !config.replication.enabled || !config.replication.repairEnabled,
    lastCompletedBacklog: 0
  }
}

async function loadEvidence(now: number = Date.now()): Promise<RepairCycleEvidence> {
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
    evidence = parseEvidence(parsed, now) ?? emptyEvidence(now)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_NOT_FOUND') throw err
    evidence = emptyEvidence(now)
  }

  if (
    evidence.membershipVersion !== membershipVersion(config.nodes) ||
    evidence.policyVersion !== currentPolicyVersion()
  ) {
    evidence = emptyEvidence(now)
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
      examined: current.examined + lastReport.examined,
      checked: current.checked + lastReport.checked,
      underReplicated: current.underReplicated + lastReport.underReplicated,
      repaired: current.repaired + lastReport.repaired.length,
      stillMissing: current.stillMissing + lastReport.stillMissing.length,
      unrecoverable: current.unrecoverable + lastReport.unrecoverable.length
    }

    // A cycle whose catch-up rounds ran out ended without covering everything
    // that arrived while it walked. It still finishes and hands the cursor back,
    // but it is not published as fresh durability evidence: the last genuinely
    // complete cycle stays in place instead, so readiness decays on its own
    // schedule rather than advancing on a coverage gap.
    const superseded = current.superseded || lastReport.uncovered > 0 || !lastReport.coverageProven
    const publishes = lastReport.cycleCompleted && !superseded

    await saveEvidence(
      lastReport.cycleCompleted
        ? {
            ...emptyEvidence(),
            lastCompletedAt: publishes ? Date.now() : current.lastCompletedAt,
            lastCompletedSuccessfully: publishes
              ? aggregate.stillMissing === 0 && aggregate.unrecoverable === 0
              : current.lastCompletedSuccessfully,
            lastCompletedBacklog: publishes
              ? aggregate.stillMissing + aggregate.unrecoverable
              : current.lastCompletedBacklog
          }
        : {
            ...current,
            superseded,
            cursor: lastReport.nextCursor,
            ...aggregate
          }
    )

    if (lastReport.cycleCompleted && superseded) {
      logger.warn(
        {
          event: 'replication_repair_cycle_superseded',
          examined: aggregate.examined,
          uncovered: lastReport.uncovered
        },
        'Repair cycle finished without covering records admitted while it ran; ' +
          'keeping the previous completed cycle as evidence'
      )
    }

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
  repairCycleDriver.triggerSchedule()
})

/**
 * Report one bounded pass.
 *
 * Whether a pass starts a cycle is decided by the persisted cursor, not by the
 * trigger: a manual pass, and a schedule tick that follows an abandoned cycle,
 * both resume the cursor a previous pass left behind.
 */
function logRepairPass(trigger: RepairTrigger): void {
  const resuming = evidence?.cursor !== undefined

  logger.info(
    {
      event: 'replication_repair_pass',
      trigger,
      resuming,
      // Bounded progress instead of the cursor, which is a CID.
      examined: evidence?.examined ?? 0
    },
    resuming ? 'Continuing replication repair cycle' : 'Starting replication repair cycle'
  )
}

const repairCycleDriver = new RepairCycleDriver({
  delayMs: config.replication.repairBatchDelayMs,
  runPass: repairUnderReplicatedFiles,
  busyError: () => new ReplicationRepairBusyError(),
  onStart: logRepairPass,
  onError: (err) => logger.error({ err }, 'Replication repair pass failed'),
  onAbandon: (err, failures) =>
    logger.error(
      {
        event: 'replication_repair_cycle_abandoned',
        failures,
        examined: evidence?.examined ?? 0,
        err
      },
      'Replication repair cycle abandoned after repeated failures; it resumes on the next schedule'
    )
})

/** Run one manual pass without interrupting automatic cycle continuation. */
export function runManualReplicationRepair(): Promise<RepairReport> {
  return repairCycleDriver.runManual()
}

/** Start the periodic repair job and immediately begin the first full cycle. */
export function startReplicationRepair(): void {
  replicationRepairCron.start()
  repairCycleDriver.start()
}

/** Stop scheduled repair work and wait for the active bounded pass. */
export async function stopReplicationRepair(): Promise<void> {
  replicationRepairCron.stop()
  await repairCycleDriver.stop()
}

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
          superseded: evidence.superseded,
          examined: evidence.examined,
          checked: evidence.checked,
          underReplicated: evidence.underReplicated,
          repaired: evidence.repaired,
          stillMissing: evidence.stillMissing,
          unrecoverable: evidence.unrecoverable,
          lastCompletedAt: evidence.lastCompletedAt,
          lastCompletedSuccessfully: evidence.lastCompletedSuccessfully,
          lastCompletedBacklog: evidence.lastCompletedBacklog
        }
      : null,
    lastRun: lastReport
      ? {
          examined: lastReport.examined,
          checked: lastReport.checked,
          releasedChecked: lastReport.releasedChecked,
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
  healthy: boolean
  backlog: number
} {
  const required = config.replication.enabled && config.replication.repairEnabled
  const activeBacklog = (evidence?.stillMissing ?? 0) + (evidence?.unrecoverable ?? 0)
  return {
    required,
    completedAt: evidence?.lastCompletedAt ?? (required ? null : Date.now()),
    healthy: !required || evidence?.lastCompletedSuccessfully === true,
    backlog: required ? Math.max(evidence?.lastCompletedBacklog ?? 0, activeBacklog) : 0
  }
}
