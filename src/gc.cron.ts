import { CronJob } from 'cron'
import { config } from './config.js'
import { helia } from './helia.js'
import { runGarbageCollection, type GcReport } from './storage/gc.js'
import { refreshStorageMetrics } from './storage/metrics.js'
import { demoteReleasableCopies } from './storage/service.js'
import { fileRegistry } from './storage/state.js'
import { logger } from './utils/logger.js'

/** A collection pass, plus the copies it handed over to other nodes first. */
export interface CollectionReport extends GcReport {
  /** Files whose local copy was released because peers hold enough copies. */
  demoted: string[]
}

let running = false
let lastReport: CollectionReport | null = null

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
): Promise<CollectionReport> {
  if (running) {
    throw new GarbageCollectionBusyError()
  }

  running = true
  try {
    // Hand copies over before collecting, so the blocks they free are reclaimed
    // by the same pass instead of waiting for the next one.
    //
    // A dry run evaluates them too. A handover unpins a local copy, so a plan
    // that leaves handovers out is not the plan the real run follows — and the
    // pre-upgrade dry run is read precisely to see which local pins go. It asks
    // the same peers the real pass would, and stops short of acting on the
    // answer.
    const demoted = (await demoteReleasableCopies({ dryRun: options.dryRun })).demoted

    const metrics = await refreshStorageMetrics()

    const report = await runGarbageCollection({
      node: helia,
      registry: fileRegistry,
      watermarks: config.storage.gc,
      blockstoreBytes: metrics.blockstoreBytes,
      availableBytes: metrics.availableBytes,
      reserveBytes: config.storage.diskReserveBytes,
      dryRun: options.dryRun,
      force: options.force,
      pinTimeoutMs: config.replication.requestTimeoutMs,
      log: (message) => logger.info(message)
    })

    const collection: CollectionReport = { ...report, demoted }

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
