import { spawnSync } from 'node:child_process'

const acceptedAdvisory = 'https://github.com/advisories/GHSA-32mq-hpph-xfvr'
const acceptedPackages = new Set(['@libp2p/kad-dht', 'helia'])

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

if (!report.metadata || typeof report.vulnerabilities !== 'object') {
  throw new Error('npm audit report is incomplete')
}

const blocking = []
const accepted = []

for (const [name, vulnerability] of Object.entries(report.vulnerabilities || {})) {
  if (!['high', 'critical'].includes(vulnerability.severity)) {
    continue
  }

  if (isAcceptedDhtFinding(name, vulnerability)) {
    accepted.push(name)
  } else {
    blocking.push(name)
  }
}

if (accepted.length > 0) {
  process.stdout.write(
    `Accepted until #21: ${accepted.join(', ')} (${acceptedAdvisory}). ` +
      'The vulnerable DHT service is installed by Helia 4 but is replaced by the explicit service map in src/helia.ts.\n'
  )
}

if (blocking.length > 0) {
  throw new Error(`Blocking high/critical production vulnerabilities: ${blocking.join(', ')}`)
}

process.stdout.write(
  'No unaccepted high or critical production dependency vulnerabilities found.\n'
)

function isAcceptedDhtFinding(name, vulnerability) {
  if (!acceptedPackages.has(name)) {
    return false
  }

  if (name === 'helia') {
    return (
      Array.isArray(vulnerability.via) &&
      vulnerability.via.length === 1 &&
      vulnerability.via[0] === '@libp2p/kad-dht'
    )
  }

  return (
    Array.isArray(vulnerability.via) &&
    vulnerability.via.length === 1 &&
    typeof vulnerability.via[0] === 'object' &&
    vulnerability.via[0] &&
    vulnerability.via[0].url === acceptedAdvisory
  )
}
