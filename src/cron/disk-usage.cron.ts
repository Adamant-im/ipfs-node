import { CronJob } from 'cron'

import { config } from '../config.js'
import { dirSize, availableStorageSize } from '../services/file/file-stats.js'
import { blockstorePath, datastorePath } from '../services/helia/store.js'
import { logger } from '../utils/logger.js'

const oneMB = 1048576

let blockstoreSizeMB = 0
let datastoreSizeMB = 0
let availableSizeInMB = 0

let isRunning = false
export const diskUsageCron = CronJob.from({
  cronTime: config.diskUsageScanPeriod,
  onTick: async () => {
    try {
      if (!isRunning) {
        isRunning = true
        logger.info('[Cron] Running "diskUsage" cronjob.')
        const duration = await scan()
        logger.info(`[Cron] "diskUsage" cronjob took ${duration} ms.`)
      }
    } catch (error) {
      logger.error(`${error.message}\n${error.stack}`)
    } finally {
      isRunning = false
    }
  },
  start: false,
  name: 'diskUsage'
})

async function scan() {
  const start = Date.now()

  const blockstoreSize = await dirSize(blockstorePath)
  if (blockstoreSize > 0) {
    blockstoreSizeMB = blockstoreSize / oneMB
  }

  const datastoreSize = await dirSize(datastorePath)
  if (datastoreSize > 0) {
    datastoreSizeMB = datastoreSize / oneMB
  }

  availableSizeInMB = Number((await availableStorageSize()) / BigInt(oneMB))
  return Date.now() - start
}

export function getDiskUsageStats() {
  return {
    blockstoreSizeMB,
    datastoreSizeMB,
    availableSizeInMB
  }
}
