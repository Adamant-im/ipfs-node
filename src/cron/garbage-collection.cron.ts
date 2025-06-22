import { CronJob } from 'cron'

import { config } from '../config.js'
import { helia } from '../services/helia/helia.js'
import { logger } from '../utils/logger.js'

let isRunning = false
export const garbageCollectionCron = CronJob.from({
  cronTime: config.garbageCollectorRunPeriod,
  onTick: async () => {
    try {
      if (!isRunning) {
        isRunning = true
        logger.info('[Cron] Running "garbageCollection" cronjob.')

        await helia.gc()

        logger.info('[Cron] "garbageCollection" cronjob finished successfully.')
      }
    } catch (error) {
      logger.error(error)
    } finally {
      isRunning = false
    }
  },
  start: false,
  name: 'garbageCollection'
})
