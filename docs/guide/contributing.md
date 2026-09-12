---
title: Contributing
description: Development setup, repository layout, the checks that must pass, and the issue and pull-request conventions used by this project.
---

# Contributing

The project is GPL-3.0 and developed in the open at
[Adamant-im/ipfs-node](https://github.com/Adamant-im/ipfs-node). The default branch is `dev`.

## Development setup

```bash
git clone https://github.com/Adamant-im/ipfs-node.git
cd ipfs-node
nvm use
npm ci
cp config.default.json5 config.json5
npm run dev
```

`npm run dev` runs the service under nodemon. `npm ci` must be allowed to run install scripts: a
native module of the WebRTC transport package downloads its prebuilt binary during installation, and
a tree installed with `--ignore-scripts` fails at startup.

Replace the peer list in `config.json5` before starting. The shipped template points at the ADAMANT
production mesh.

## Repository layout

| Path                | Contents                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `src/api/`          | Express routers, grouped by access class                                          |
| `src/middleware/`   | Rate limiting, admission control, upload and download guards, error handling      |
| `src/security/`     | CORS, trusted proxy, API key, rate-limit policy, access-policy mounting           |
| `src/storage/`      | Lifecycle registry, admission, placement, replication, repair, collection         |
| `src/health/`       | Checkpoint state, health service, libp2p health protocol, membership              |
| `src/utils/`        | Logger, CID helpers, download responses, filename sanitization                    |
| `test/`             | Unit suites                                                                       |
| `test/integration/` | Multi-node integration suites                                                     |
| `docs/`             | The documentation site, the OpenAPI document, and the storage lifecycle reference |
| `scripts/`          | Audit, documentation generation and validation, container smoke test              |

## Checks

| Command                    | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `npm run lint`             | ESLint over the repository                                                |
| `npm run format`           | Prettier in check mode; `npm run format:fix` writes                       |
| `npm run typecheck`        | `tsc --noEmit` over `src` and `test`                                      |
| `npm run build`            | Compiles `src` into `dist`                                                |
| `npm test`                 | Builds into `dist-test`, then runs the unit and integration suites        |
| `npm run security:audit`   | Fails on any high or critical production advisory                         |
| `npm run security:semgrep` | Static analysis over `src/`; needs the `semgrep` CLI installed separately |
| `npm run docs:build`       | Generates the API reference, builds the site, and validates the artifact  |

`npm test` runs Node's built-in test runner against `config.test.json5`, which has no bootstrap
peers and listens on loopback with an OS-assigned port. The unit suites cover the HTTP security
boundary, configuration validation, filename sanitization, disk measurement, the storage lifecycle,
and health state. The integration suites start isolated nodes with temporary stores, transfer a file
between them over Bitswap, exercise the replication protocol, and verify that a peer identity
survives a restart.

Continuous integration runs lint, format, build, test build, unit tests, and integration tests on
every push and pull request against `dev`. Separate workflows build and smoke-test the container
image and build the documentation site.

To exercise the container locally:

```bash
docker build -t ipfs-node:local .
./scripts/docker-smoke-test.sh ipfs-node:local
```

## TypeScript project layout

Three configurations share one set of compiler options:

| File                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `tsconfig.json`       | Type-checks `src` and `test`. Emits nothing; this is what editors use |
| `tsconfig.build.json` | Builds `src` into `dist` for `npm run build`                          |
| `tsconfig.test.json`  | Builds `src` and `test` into `dist-test` for `npm test`               |

Pass no file arguments to `tsc`. Naming a file on the command line makes TypeScript ignore
`tsconfig.json` entirely, so `outDir` is not applied — the `.js` file is written next to its source
— and the project's `lib`, `module`, and `moduleResolution` settings are replaced by defaults, which
reports module-resolution and missing-`@types/node` errors the project does not have.

## Documentation

The site is VitePress, sourced from `docs/`.

```bash
npm run docs:dev      # local preview with hot reload
npm run docs:build    # generate, build, and validate
npm run docs:preview  # serve the built site
```

Two things are generated and must not be edited by hand:

- `docs/reference/endpoints.md` is generated from `docs/openapi.yaml` by
  `scripts/generate-api-reference.mjs`. Change the specification, not the page
- `docs/public/openapi.yaml` is a copy of the same specification, served by the site

The build fails on a broken internal link, a missing generated API reference, a missing or wrong
`CNAME`, or a leaked build path. `docs/storage-lifecycle.md` and `docs/openapi.yaml` keep their
paths so existing repository links stay valid.

Writing rules live in `AGENTS.md` and apply to human and AI contributors alike. The ones that come
up most: English only, a blank line before and after every list, no trailing period on a
single-sentence list item, a language tag on every fenced block, and no capability, privacy,
resource, or scale claim that the code, the tests, or a recorded measurement does not support.

## Issues and pull requests

Follow the [ADAMANT organization governance](https://github.com/Adamant-im/.github).

- Search existing issues before opening a new one, and use one concise title prefix such as
  `[Bug]`, `[Feat]`, `[Enhancement]`, `[Refactor]`, `[Docs]`, `[Test]`, `[Chore]`, `[Task]`, or
  `[Composite]`
- Pull request titles use `Type: Short summary`, for example `Docs: Add configuration reference`
- Commit messages follow Conventional Commits
- Structure the pull request body with `Description`, `Related issue`, `How to test`, and
  `Checklist`, and reference the issue with a closing keyword when appropriate
- Include validation evidence, and say which checks were not run

Keep the public surface synchronized. When behaviour changes, `README.md`, this site,
`docs/openapi.yaml`, the container files, and `package.json` metadata are updated in the same
change, or the omission is stated deliberately.

## Security

Report suspected vulnerabilities privately through GitHub security advisories on
[the repository](https://github.com/Adamant-im/ipfs-node) rather than by opening a public issue.
Everything that is not a vulnerability belongs in the
[issue tracker](https://github.com/Adamant-im/ipfs-node/issues).
