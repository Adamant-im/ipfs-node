# IPFS Node: AI Agent Operating Manual

This document defines how AI agents must work in this repository. It intentionally contains only general guidance; add project-specific technical instructions only after verifying them against the current codebase.

## Priorities

Optimize agent work for:

1. Reliability and correctness
2. Security and privacy
3. Simplicity and maintainability
4. Clear collaboration with contributors

Prefer the smallest safe change that fully addresses the task. Avoid unrelated rewrites and speculative abstractions.

## Product Positioning

ADAMANT IPFS Node is a universal, self-hostable open-source product: an IPFS storage node for
application file delivery, with bounded disk usage, deterministic replication, repair, health
checkpoints, and a REST API. ADAMANT Messenger is a real adopter and the reference deployment,
not the product's purpose.

- Write user-facing copy and examples so a non-ADAMANT application can use them unchanged
- Present ADAMANT Messenger as one adopter and one worked example, never as the intended consumer
- Keep ADAMANT-specific values out of defaults that a new deployment would copy blindly; the peer
  list in `config.default.json5` points at the ADAMANT production mesh, so any example a stranger
  is expected to run must use an empty or placeholder peer set
- Describe the service as a standalone Node.js and Helia application, never as a Kubo wrapper or a
  Kubo-compatible API

### Claims

Derive every capability, decentralization, privacy, resource, and scale claim from current code,
current tests, or a reproducible measurement recorded in the repository.

- Do not publish CPU, memory, disk, throughput, latency, concurrency, or uptime figures that no
  recorded measurement supports; "simple" and "low-resource" are claims, not adjectives
- Do not describe planned or in-progress work as an available feature; name the open issue instead
- State the boundary next to the benefit: a controlled peer topology avoids the public DHT and
  public gateways and reduces public exposure of content-routing metadata, but does not by itself
  make a deployment private, anonymous, trustless, or censorship-proof
- Availability still depends on independent nodes, independent operators, replication settings, and
  deployer choices; do not turn a durability policy into an availability guarantee

### Public surface synchronization

`README.md`, the documentation site under `docs/`, `docs/openapi.yaml`, the container files and
examples, `package.json` metadata, and the GitHub repository presentation describe one product.
When public behavior changes, update all of them in the same change, or state explicitly which one
was deliberately left alone and why.

## Language Policy

- Developers may communicate with AI in any language
- All repository artifacts must be in English
- Write code, comments, documentation, commit messages, issue text, and PR text in English

## Writing and Documentation

- Use concise, operational wording
- Keep one blank line before and after Markdown lists
- In lists, omit the trailing period when an item contains one sentence; if an item contains multiple sentences, punctuate every sentence
- Use fenced code blocks with matching fences and a language tag when applicable
- Write JSDoc for public modules, exported functions, reusable helpers, and functions materially changed by the task
- In JSDoc, explain purpose, parameter semantics, and non-obvious return values
- Add short comments for non-obvious logic, constraints, security decisions, compatibility behavior, or workarounds; do not restate the code
- Keep documentation aligned with current behavior whenever code changes

## Sources of Truth

Use current repository code, configuration, tests, and `README.md` as the primary sources for implementation behavior. Also follow:

- [ADAMANT organization governance](https://github.com/Adamant-im/.github)
- [ADAMANT issue title guidance](https://github.com/orgs/Adamant-im/discussions/5)
- [ADAMANT label guidance](https://github.com/orgs/Adamant-im/discussions/1)
- [ADAMANT documentation](https://docs.adamant.im)

When sources disagree:

1. Treat current code and passing tests as implementation truth
2. Document the mismatch instead of silently choosing or changing behavior
3. Propose synchronized documentation or follow-up work when needed

Do not infer project architecture, runtime behavior, or operational procedures from stale documentation. Verify technical details before adding them to this file.

## Change Discipline

1. Read the relevant files end-to-end before editing
2. Identify the requested scope and behavior that must remain unchanged
3. Make a focused change with an explicit rationale
4. Add or update tests near changed behavior when applicable
5. Run targeted checks first, then broader checks in proportion to risk
6. Review the final diff for unintended changes
7. Report assumptions, risks, skipped checks, and deferred work

Preserve backward compatibility unless the task explicitly approves a breaking change. Improve legacy code locally, but do not turn a focused task into a broad refactor.

## Security, Privacy, and Reliability

- Never expose secrets, passphrases, private keys, tokens, credentials, or sensitive user data in code, logs, tests, fixtures, issues, or PRs
- Keep validation strict for untrusted input and external data
- Do not introduce dynamic code execution, unsafe deserialization, unvalidated shell execution, or insecure fallbacks
- Minimize new dependencies and justify additions, especially for security-sensitive or network-facing code
- Fail safely on malformed data, timeouts, and partial external failures
- Preserve existing privacy, decentralization, and self-hosting properties
- Stop and request maintainer guidance when a change has unclear security, privacy, compatibility, or data-integrity consequences

## Install scripts

npm 12 blocks dependency `preinstall`, `install`, and `postinstall` scripts unless the package is
listed in `package.json` `allowScripts`. `.npmrc` sets `strict-allow-scripts=true`, so `npm ci`
fails when a new unreviewed script appears instead of silently skipping it and producing a tree
that cannot start Helia.

This repository allows only:

- `node-datachannel` — Helia depends on `@libp2p/webrtc`; the native binary is required to import the runtime
- `esbuild` — VitePress documentation tooling
- `fsevents` — optional macOS file watching for `npm run dev`

The entries are package names, not pinned versions, so a routine lockfile bump of the same package
does not need a second approval.

When a lockfile change introduces a package with an install script:

1. Run `npm install-scripts ls` and read the names
2. Approve only what this project needs: `npm install-scripts approve --no-allow-scripts-pin <pkg>`
3. Do not use `approve --all` without reviewing each name
4. Never install a runnable or testable tree with `--ignore-scripts`; that flag is only for the
   documentation-site and security-audit CI jobs, and for auditing

A process that crashes with `Cannot find module '.../node_datachannel.node'` was installed without
the native binary. Delete `node_modules`, run a normal `npm ci` that can reach GitHub releases, and
confirm `node_modules/node-datachannel/build/Release/node_datachannel.node` exists before starting.

## Validation Policy

- Use repository-defined scripts and configuration as the source of truth for checks
- Run the narrowest relevant validation first and broaden it when shared or high-risk behavior changes
- For documentation-only changes, run Markdown lint and repository diff checks
- Never claim a check passed unless it was actually executed
- Report exact commands, results, and any checks that were not run

When you change JavaScript, TypeScript, JSON, Markdown, YAML, or other files covered by
Prettier, run `npm run format` before you report the work done. CI fails on `prettier --check`
the same way it fails on ESLint. Use `npm run format:fix` to apply formatting, then run
`npm run format` again to confirm a clean check.

For code changes, run checks in the same order as the CI workflow when practical:
`npm run lint`, `npm run format`, `npm run typecheck`, then targeted or full tests.

Documentation site and container work carries further expectations:

- Build the documentation site from the lockfile before claiming it works, and treat a broken
  internal link, a missing generated API reference, or a missing custom-domain file as a failure
  rather than a warning
- Exercise a container image at runtime before claiming it works: it must start from mounted
  configuration, run unprivileged, reach the documented health state, serve an upload and a
  download, keep its persistent state and peer identity across replacement, and shut down cleanly
  on `SIGTERM`
- Keep validation instructions in terms of repository scripts, not of a specific base image, tag,
  runner, or registry path, so they do not go stale

## Issue, Label, and PR Conventions

Follow organization-wide governance, templates, title conventions, and label casing.

### Issues

- Search existing issues before creating a new one
- Use the appropriate organization issue template
- Use one concise title prefix, or two only when necessary: `[Bug]`, `[Feat]`, `[Enhancement]`, `[Refactor]`, `[Docs]`, `[Test]`, `[Chore]`, `[Task]`, or `[Composite]`
- Apply a minimal informative label set: one type or status label, relevant domain labels, and an optional priority label
- Link related issues and PRs explicitly

### Pull requests and commits

- Use `Type: Short summary` for PR titles, such as `Docs: Add AGENTS.md`; do not use issue-style square brackets
- Keep the PR title type aligned with the issue intent: `Docs:`, `Fix:`, `Feat:`, `Refactor:`, `Test:`, or `Chore:`
- Use Conventional Commits style for commit messages
- Structure the PR body with `Description`, `Related issue`, `How to test`, and `Checklist` sections
- Reference the issue with a closing keyword when appropriate, such as `Closes #123`
- Include validation evidence and note relevant risks or intentionally unchanged behavior
- Add a link to the PR in the related issue

### Branches and releases

- Target `dev` with every pull request; it is the default and integration branch
- Cut a release from `master`: merge `dev` into `master`, tag that commit `vX.Y.Z`, and publish a GitHub Release from the tag
- Keep the tag and the `package.json` version in agreement; container publication verifies both the version and that the tagged commit is an ancestor of `master`
- Do not tag a release on `dev` or on a feature branch; publication refuses it

### Command-line content

For multi-line CLI input, use a dated temporary Markdown file under `.ai-ignored/` and a file-based flag such as `--body-file`. Do not put multi-line issue, PR, or commit text directly in a shell argument.

## Definition of Done

A change is complete only when:

- The requested behavior or documentation is implemented without unrelated scope expansion
- Security, privacy, reliability, and compatibility are preserved
- Relevant validation has passed or blockers are reported clearly
- Documentation and configuration are updated when behavior changes
- Repository artifacts are in English
- The final report states what changed, what was verified, and what remains
