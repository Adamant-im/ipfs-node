import { CronJob } from 'cron'
import { config } from './config.js'
import { helia } from './helia.js'
import { runGarbageCollection, type GcReport } from './storage/gc.js'
import { refreshStorageMetrics } from './storage/metrics.js'
import { fileRegistry } from './storage/state.js'
import { logger } from './utils/logger.js'

let running = false
let lastReport: GcReport | null = null

export class GarbageCollectionBusyError extends Error {
  constructor() {
    super('Garbage collection is already running')
    this.name = 'GarbageCollectionBusyError'
  }
}

/**
 * Run one collection pass.
 *
 * Metrics are refreshed first so the watermark decision uses the current
 * blockstore size rather than the value cached by the disk usage schedule.
 *
 * @param options.dryRun report the plan without unpinning or deleting anything
 * @param options.force collect even when the blockstore is below the high watermark
 */
export async function collectGarbage(
  options: { dryRun?: boolean; force?: boolean } = {}
): Promise<GcReport> {
  if (running) {
    throw new GarbageCollectionBusyError()
  }

  running = true
  try {
    const metrics = await refreshStorageMetrics()

    const report = await runGarbageCollection({
      node: helia,
      registry: fileRegistry,
      watermarks: config.storage.gc,
      blockstoreBytes: metrics.blockstoreBytes,
      dryRun: options.dryRun,
      force: options.force,
      pinTimeoutMs: config.replication.requestTimeoutMs,
      log: (message) => logger.info(message)
    })

    if (!report.dryRun) {
      lastReport = report
      await refreshStorageMetrics()
    }

    return report
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
          releasedFiles: lastReport.releasedCids.length,
          removedBlocks: lastReport.removedBlocks,
          repairedPins: lastReport.repairedPins.length,
          errors: lastReport.errors.length
        }
      : null
  }
}
