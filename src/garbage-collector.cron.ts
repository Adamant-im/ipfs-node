import { CronJob } from 'cron'

import { config } from './config.js'
import { helia } from './helia.js'
import { logger } from './utils/logger.js'

let isRunning = false
export const gcCron = CronJob.from({
  cronTime: config.garbageCollectorRunPeriod,
  onTick: async () => {
    try {
      if (!isRunning) {
        isRunning = true
        logger.info('[Cron] Running "gcRun" cronjob.')
        await helia.gc()
        logger.info('[Cron] "gcRun" cronjob finished successfully.')
        isRunning = false
      }
    } catch (error) {
      logger.error(error)
    } finally {
      isRunning = false
    }
  },
  start: false,
  name: 'gcRun'
})
