#!/usr/bin/env node
/**
 * Generate the documentation-site API reference from `docs/openapi.yaml`.
 *
 * The specification is the single source of truth for the public contract, so
 * the endpoint tables are derived from it instead of being retyped. Two
 * artifacts are produced:
 *
 * - `docs/reference/endpoints.md`, the generated endpoint reference
 * - `docs/public/openapi.yaml`, the machine-readable copy the site serves
 *
 * Both are generated, so both are ignored by Git. A missing or unusable
 * specification fails the build rather than publishing a site without its API
 * reference.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const specPath = join(rootDir, 'docs', 'openapi.yaml')
const referencePath = join(rootDir, 'docs', 'reference', 'endpoints.md')
const publicSpecPath = join(rootDir, 'docs', 'public', 'openapi.yaml')

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/** Fail with a message an operator can act on rather than a stack trace. */
function fail(message) {
  console.error(`generate-api-reference: ${message}`)
  process.exit(1)
}

/**
 * Escape the characters that would break a Markdown table cell.
 *
 * @param value Text taken from the specification
 */
function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

/**
 * Describe the authentication a specification operation requires.
 *
 * The node has exactly one scheme, the administrative `x-api-key` header, so an
 * operation either carries a `security` block or is public.
 *
 * @param operation Parsed OpenAPI operation object
 */
function authentication(operation) {
  const security = operation.security ?? []
  if (security.length === 0) {
    return 'Public'
  }
  const names = security.flatMap((requirement) => Object.keys(requirement))
  return names.includes('AdminApiKey') ? '`x-api-key`' : names.join(', ')
}

/**
 * Render the response table of one operation.
 *
 * @param operation Parsed OpenAPI operation object
 */
function responseRows(operation) {
  const responses = operation.responses ?? {}
  return Object.entries(responses).map(([status, response]) => {
    const description =
      response?.description ??
      (typeof response?.$ref === 'string' ? response.$ref.split('/').pop() : '')
    return `| \`${cell(status)}\` | ${cell(description)} |`
  })
}

/**
 * Render every path of the specification as a Markdown section.
 *
 * @param spec Parsed OpenAPI document
 */
function renderOperations(spec) {
  const lines = []
  const summary = []

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item?.[method]
      if (operation === undefined) {
        continue
      }

      const verb = method.toUpperCase()
      const anchor = `${verb.toLowerCase()}-${path
        .replace(/[{}]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`

      summary.push(
        `| [\`${verb} ${cell(path)}\`](#${anchor}) | ${cell(operation.summary)} | ${authentication(operation)} |`
      )

      lines.push(`### \`${verb} ${path}\` {#${anchor}}`)
      lines.push('')
      if (operation.summary) {
        lines.push(cell(operation.summary))
        lines.push('')
      }
      if (operation.description) {
        lines.push(String(operation.description).trim())
        lines.push('')
      }
      lines.push(`Authentication: ${authentication(operation)}`)
      lines.push('')

      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].filter(
        (parameter) => parameter.$ref === undefined
      )
      if (parameters.length > 0) {
        lines.push('| Parameter | In | Required | Description |')
        lines.push('| --------- | -- | -------- | ----------- |')
        for (const parameter of parameters) {
          lines.push(
            `| \`${cell(parameter.name)}\` | ${cell(parameter.in)} | ${parameter.required === true ? 'yes' : 'no'} | ${cell(parameter.description ?? '')} |`
          )
        }
        lines.push('')
      }

      const rows = responseRows(operation)
      if (rows.length > 0) {
        lines.push('| Status | Meaning |')
        lines.push('| ------ | ------- |')
        lines.push(...rows)
        lines.push('')
      }
    }
  }

  return { lines, summary }
}

const raw = await readFile(specPath, 'utf8').catch((err) =>
  fail(`cannot read ${specPath}: ${err.message}`)
)

let spec
try {
  spec = parse(raw)
} catch (err) {
  fail(`cannot parse ${specPath}: ${err.message}`)
}

if (spec?.paths === undefined || Object.keys(spec.paths).length === 0) {
  fail(`${specPath} declares no paths; the API reference would be empty`)
}

const { lines, summary } = renderOperations(spec)

if (summary.length === 0) {
  fail(`${specPath} declares no operations; the API reference would be empty`)
}

const page = [
  '---',
  'title: Endpoint reference',
  'editLink: false',
  '---',
  '',
  '<!-- Generated by scripts/generate-api-reference.mjs from docs/openapi.yaml. Do not edit. -->',
  '',
  '# Endpoint reference',
  '',
  `Generated from [\`docs/openapi.yaml\`](/openapi.yaml) — \`${cell(spec.info?.title ?? 'API')}\`, contract version \`${cell(spec.info?.version ?? 'unversioned')}\`.`,
  '',
  'This page lists the stable client, lifecycle, and node-health contract. Low-level Helia,',
  'libp2p, and optional debug operator routes are intentionally left out of the specification;',
  'they are described in [Administrative and debug routes](./api#administrative-and-debug-routes).',
  '',
  'Download the machine-readable specification: [`openapi.yaml`](/openapi.yaml).',
  '',
  '## Operations',
  '',
  '| Operation | Summary | Authentication |',
  '| --------- | ------- | -------------- |',
  ...summary,
  '',
  '## Details',
  '',
  ...lines
].join('\n')

await mkdir(dirname(referencePath), { recursive: true })
await mkdir(dirname(publicSpecPath), { recursive: true })
await writeFile(referencePath, `${page.trimEnd()}\n`, 'utf8')
await writeFile(publicSpecPath, raw, 'utf8')

console.log(
  `generate-api-reference: wrote ${summary.length} operations to docs/reference/endpoints.md`
)
