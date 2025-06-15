import { blockstorePath, datastorePath } from './store.js'
import { dirSize, availableStorageSize } from './utils/utils.js'
import { CronJob } from 'cron'
import { config } from './config.js'
import { logger } from './utils/logger.js'

const oneMb = 1048576

let blockstoreSizeMb = 0
let datastoreSizeMb = 0
let availableSizeInMb = 0

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
        isRunning = false
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
    blockstoreSizeMb = blockstoreSize / oneMb
  }

  const datastoreSize = await dirSize(datastorePath)
  if (datastoreSize > 0) {
    datastoreSizeMb = datastoreSize / oneMb
  }

  availableSizeInMb = Number((await availableStorageSize()) / BigInt(oneMb))
  return Date.now() - start
}

export function getDiskUsageStats() {
  return {
    blockstoreSizeMb,
    datastoreSizeMb,
    availableSizeInMb
  }
}
