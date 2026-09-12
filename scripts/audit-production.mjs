import { spawnSync } from 'node:child_process'

/**
 * Environment for the audit child process.
 *
 * `npm run` exports every resolved setting as an `npm_config_*` variable, and a
 * nested `npm` re-reads them as command-line flags. npm 12 rejects
 * `--allow-scripts` outside a global install, so a developer who sets
 * `allow-scripts` in a personal `.npmrc` makes this script — and therefore the
 * pre-push hook — fail with `EALLOWSCRIPTS` instead of producing a report.
 * Dropping that one inherited setting keeps the child reading the same config
 * files and cache as the parent.
 */
const env = { ...process.env }
delete env.npm_config_allow_scripts

const result = spawnSync('npm', ['audit', '--omit=dev', '--omit=peer', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  env
})

if (result.error) {
  throw result.error
}

if (!result.stdout) {
  throw new Error(result.stderr || 'npm audit produced no report')
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  throw new Error('npm audit produced invalid JSON')
}

// npm reports its own failures as `{ "error": { code, summary } }`, which parses
// cleanly but carries no findings. Surfacing that summary is what turns an
// unusable report into a message an operator can act on.
if (report.error) {
  throw new Error(
    `npm audit failed: ${report.error.summary || report.error.code || 'unknown error'}`
  )
}

if (
  !report.metadata ||
  report.vulnerabilities === null ||
  typeof report.vulnerabilities !== 'object'
) {
  throw new Error('npm audit report is incomplete')
}

const blocking = []

for (const [name, vulnerability] of Object.entries(report.vulnerabilities || {})) {
  if (['high', 'critical'].includes(vulnerability.severity)) {
    blocking.push(name)
  }
}

if (blocking.length > 0) {
  throw new Error(`Blocking high/critical production vulnerabilities: ${blocking.join(', ')}`)
}

process.stdout.write(
  'No unaccepted high or critical production dependency vulnerabilities found.\n'
)
