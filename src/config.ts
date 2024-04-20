import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import JSON5 from 'json5'
import { pino } from './utils/logger'

const currDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(currDir, '..')

const configName = process.argv.slice(2)[0] || 'default'
const configFileName = `config.${configName}.json5`
pino.logger.debug('Using config file:', configFileName)

const configPath = rootDir + `/${configFileName}`

const config = JSON5.parse(fs.readFileSync(configPath, 'utf8'))

export default config
