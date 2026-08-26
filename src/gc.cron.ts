import { CronJob } from 'cron'
import { config } from './config.js'
import { helia } from './helia.js'
import { recoverInterruptedAdmissions } from './storage/admission.js'
import { collectStorage, type CollectionReport } from './storage/collection.js'
import { refreshStorageMetrics } from './storage/metrics.js'
import { demoteReleasableCopies } from './storage/service.js'
import { fileRegistry, storageOperationLock } from './storage/state.js'
import { logger } from './utils/logger.js'

let running = false
let lastReport: CollectionReport | null = null

export class GarbageCollectionBusyError extends Error {
  constructor() {
    super('Garbage collection is already running')
    this.name = 'GarbageCollectionBusyError'
  }
}

/**
 * Run one collection pass against this node.
 *
 * The pass itself lives in `collectStorage`, which takes what it works on; this
 * is the wiring plus the guard that keeps two passes from overlapping.
 *
 * @param options.dryRun report the plan without unpinning or deleting anything
 * @param options.force collect even when the blockstore is below the high watermark
 */
export async function collectGarbage(
  options: { dryRun?: boolean; force?: boolean } = {}
): Promise<CollectionReport> {
  if (running) {
    throw new GarbageCollectionBusyError()
  }

  running = true
  try {
    // Dry-run is a report. Clearing leftover tokens would still be a write.
    if (options.dryRun !== true) {
      await recoverStaleAdmissions()
    }

    const collection = await collectStorage({
      lock: storageOperationLock,
      node: helia,
      registry: fileRegistry,
      watermarks: config.storage.gc,
      reserveBytes: config.storage.diskReserveBytes,
      demote: demoteReleasableCopies,
      measure: refreshStorageMetrics,
      dryRun: options.dryRun,
      force: options.force,
      log: (message) => logger.info(message)
    })

    if (!collection.dryRun) {
      lastReport = collection
      await refreshStorageMetrics()
    }

    return collection
  } finally {
    running = false
  }
}

export const garbageCollectionCron = new CronJob(config.storage.gc.schedule, () => {
  if (running) {
    return
  }

  logger.info('[Cron] Running "garbageCollection" cronjob.')
  collectGarbage().catch((err) => logger.error(`${err.message}\n${err.stack}`))
})

/**
 * Clear leftover upload tokens when the collector itself is off.
 *
 * Recovery also runs inside {@link collectGarbage}. This job exists so an
 * operator who disables the collector still un-wedges CIDs whose handler died.
 */
export const admissionRecoveryCron = new CronJob(config.storage.gc.schedule, () => {
  logger.info('[Cron] Running "admissionRecovery" cronjob.')
  recoverStaleAdmissions().catch((err) => logger.error(`${err.message}\n${err.stack}`))
})

async function recoverStaleAdmissions(): Promise<void> {
  const recovery = await recoverInterruptedAdmissions(fileRegistry)
  for (const error of recovery.errors) {
    logger.warn(`Admission recovery: ${error}`)
  }
  if (recovery.recovered > 0) {
    logger.info(`Admission recovery: cleared ${recovery.recovered} interrupted uploads`)
  }
}

export function getGarbageCollectionState() {
  return {
    enabled: config.storage.gc.enabled,
    schedule: config.storage.gc.schedule,
    highWatermarkBytes: config.storage.gc.highWatermarkBytes,
    lowWatermarkBytes: config.storage.gc.lowWatermarkBytes,
    running,
    lastRun: lastReport
      ? {
          startedAt: lastReport.startedAt,
          durationMs: lastReport.durationMs,
          collected: lastReport.collected,
          trigger: lastReport.trigger,
          releasedFiles: lastReport.releasedCids.length,
          demotedFiles: lastReport.demoted.length,
          removedBlocks: lastReport.removedBlocks,
          repairedPins: lastReport.repairedPins.length,
          errors: lastReport.errors.length
        }
      : null
  }
}
