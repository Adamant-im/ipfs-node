import { downloadLimiter } from '../storage/state.js'
import { createDownloadAdmission } from './downloadAdmission.js'

/** Production global concurrency guard for public file retrieval. */
export const admitDownload = createDownloadAdmission(downloadLimiter)
