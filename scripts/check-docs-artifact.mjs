#!/usr/bin/env node
/**
 * Validate the built documentation site before it can be deployed.
 *
 * GitHub Pages serves whatever the artifact contains, so a missing custom
 * domain, a missing generated API reference, or a leaked absolute build path
 * would only be discovered in production. Each of those fails the build here
 * instead.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(rootDir, 'docs', '.vitepress', 'dist')

/** Custom domain the Pages deployment must serve; see docs/public/CNAME. */
const EXPECTED_CNAME = 'ipfs-node.docs.adamant.im'

/** Files the artifact must contain for the site to be complete. */
const REQUIRED_FILES = [
  'index.html',
  'CNAME',
  'openapi.yaml',
  'sitemap.xml',
  'favicon.svg',
  join('reference', 'endpoints.html'),
  join('reference', 'api.html')
]

const failures = []

/**
 * Collect every file below `dir`, relative to the artifact root.
 *
 * @param dir Directory to walk
 */
async function walk(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walk(full)))
    } else if (entry.isFile()) {
      found.push(full)
    }
  }
  return found
}

try {
  const stats = await stat(distDir)
  if (!stats.isDirectory()) {
    throw new Error('not a directory')
  }
} catch {
  console.error(`check-docs-artifact: ${distDir} is missing; run "npm run docs:build" first`)
  process.exit(1)
}

for (const file of REQUIRED_FILES) {
  try {
    await stat(join(distDir, file))
  } catch {
    failures.push(`missing required artifact file: ${file}`)
  }
}

try {
  const cname = (await readFile(join(distDir, 'CNAME'), 'utf8')).trim()
  if (cname !== EXPECTED_CNAME) {
    failures.push(`CNAME is "${cname}"; expected "${EXPECTED_CNAME}"`)
  }
} catch {
  // The missing-file check above already reported this.
}

// A build path leaks the machine that produced the artifact, and a home
// directory is the form that shows up in stack traces and source maps.
const home = homedir()
const files = await walk(distDir)
for (const file of files) {
  if (!/\.(html|js|css|json|xml|yaml)$/.test(file)) {
    continue
  }
  const contents = await readFile(file, 'utf8')
  if (home.length > 1 && contents.includes(home)) {
    failures.push(`${relative(distDir, file)} contains the build machine home directory`)
  }
  if (
    contents.includes('adminApiKey') &&
    /adminApiKey['"]?\s*[:=]\s*['"][0-9a-f]{32,}/.test(contents)
  ) {
    failures.push(`${relative(distDir, file)} appears to contain a concrete administrative key`)
  }
}

if (failures.length > 0) {
  console.error('check-docs-artifact: the built site is not publishable')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}

console.log(`check-docs-artifact: ${files.length} files verified in docs/.vitepress/dist`)
