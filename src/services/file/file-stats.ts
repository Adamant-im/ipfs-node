import { statfs } from 'node:fs/promises'

import { getFolderSizeBin } from 'go-get-folder-size'

import { logger } from '../../utils/logger.js'
import { UnixFsMulterFile } from '../types.js'

export function flatFiles(
  files:
    | {
        [fieldname: string]: UnixFsMulterFile[]
      }
    | UnixFsMulterFile[]
) {
  let resultFiles: UnixFsMulterFile[] = []
  if (Array.isArray(files)) {
    return files
  } else {
    for (const filename in files) {
      if (Object.prototype.hasOwnProperty.call(files, filename)) {
        resultFiles = [...resultFiles, ...files[filename]]
      }
    }
    return resultFiles
  }
}

export async function availableStorageSize() {
  const statistics = await statfs('/', { bigint: true })
  return statistics.bsize * statistics.bavail
}

export async function dirSize(dir: string): Promise<number> {
  try {
    return await getFolderSizeBin(dir, false, { loose: true })
  } catch (error) {
    logger.error(error)
  }
  return 0
}
