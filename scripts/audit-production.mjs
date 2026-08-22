import { spawnSync } from 'node:child_process'

const result = spawnSync('npm', ['audit', '--omit=dev', '--omit=peer', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024
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
