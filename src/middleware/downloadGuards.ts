import { config } from '../config.js'
import { downloadLimiter } from '../storage/state.js'
import { createDownloadAdmission } from './downloadAdmission.js'

/** Production concurrency guard for public file retrieval, global and per client. */
export const admitDownload = createDownloadAdmission(downloadLimiter, {
  perClientLimit: config.storage.maxConcurrentDownloadsPerClient
})
