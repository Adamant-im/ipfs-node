import { blockstorePath, datastorePath } from './store.js'
import { dirSize, availableStorageSize } from './utils/utils.js'
import { CronJob } from 'cron'
import { config } from './config.js'
import { pino } from './utils/logger.js'

const oneMb = 1048576

let blockstoreSizeMb = 0
let datastoreSizeMb = 0
let availableSizeInMb = 0

let started = false
export const diskUsageCron = new CronJob(config.diskUsageScanPeriod, () => {
  if (!started) {
    started = true
    scan()
      .catch((err) => pino.logger.error(`${err.message}\n${err.stack}`))
      .finally(() => (started = false))
  }
})

async function scan() {
  pino.logger.info('[Cron] Running "diskUsage" cronjob.')
  blockstoreSizeMb = (await dirSize(blockstorePath)) / oneMb
  datastoreSizeMb = (await dirSize(datastorePath)) / oneMb
  availableSizeInMb = Number((await availableStorageSize()) / BigInt(oneMb))
}

scan().catch(pino.logger.error)

export function getDiskUsageStats() {
  return {
    blockstoreSizeMb,
    datastoreSizeMb,
    availableSizeInMb
  }
}
