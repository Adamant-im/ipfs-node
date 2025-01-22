import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import JSON5 from 'json5'

const currDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(currDir, '..')

export const CONFIG_FILE_NAME = 'config.json5'

const configPath = join(rootDir, CONFIG_FILE_NAME)

export const config = JSON5.parse(fs.readFileSync(configPath, 'utf8'))

export const packageJson = JSON5.parse(fs.readFileSync(join(rootDir, 'package.json'), 'utf8'))
