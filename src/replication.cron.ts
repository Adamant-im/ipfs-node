import { CronJob } from 'cron'
import { config } from './config.js'
import { repairReplication, type RepairReport } from './storage/service.js'
import { logger } from './utils/logger.js'

let running = false
let lastReport: RepairReport | null = null

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
    lastReport = await repairReplication()

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
    factor: config.replication.factor,
    ackQuorum: config.replication.ackQuorum,
    requireQuorumOnUpload: config.replication.requireQuorumOnUpload,
    repairEnabled: config.replication.repairEnabled,
    repairSchedule: config.replication.repairSchedule,
    running,
    lastRun: lastReport
  }
}
