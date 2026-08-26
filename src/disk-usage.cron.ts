import { CronJob } from 'cron'
import { config } from './config.js'
import { getStorageMetrics, refreshStorageMetrics } from './storage/metrics.js'
import { logger } from './utils/logger.js'

const oneMb = 1048576

let started = false
export const diskUsageCron = new CronJob(config.diskUsageScanPeriod, () => {
  if (!started) {
    started = true
    scan()
      .catch((err) => logger.error(`${err.message}\n${err.stack}`))
      .finally(() => (started = false))
  }
})

async function scan() {
  logger.info('[Cron] Running "diskUsage" cronjob.')
  const start = Date.now()

  // The same scan feeds the byte-accurate storage report, so both stay in step.
  await refreshStorageMetrics()

  logger.info(`Check folder size took ${Date.now() - start} ms.`)
}

scan().catch((err) => logger.error(`${err.message}\n${err.stack}`))

/**
 * Disk usage in megabytes, kept for the existing `/api/node/info` payload.
 * Byte-accurate values and lifecycle counters live in the storage metrics.
 */
export function getDiskUsageStats() {
  const metrics = getStorageMetrics()

  return {
    blockstoreSizeMb: metrics.blockstoreBytes / oneMb,
    datastoreSizeMb: metrics.datastoreBytes / oneMb,
    availableSizeInMb: metrics.availableBytes / oneMb
  }
}
