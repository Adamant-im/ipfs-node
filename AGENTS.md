# IPFS Node: AI Agent Operating Manual

This document defines how AI agents must work in this repository. It intentionally contains only general guidance; add project-specific technical instructions only after verifying them against the current codebase.

## Priorities

Optimize agent work for:

1. Reliability and correctness
2. Security and privacy
3. Simplicity and maintainability
4. Clear collaboration with contributors

Prefer the smallest safe change that fully addresses the task. Avoid unrelated rewrites and speculative abstractions.

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

## Validation Policy

- Use repository-defined scripts and configuration as the source of truth for checks
- Run the narrowest relevant validation first and broaden it when shared or high-risk behavior changes
- For documentation-only changes, run Markdown lint and repository diff checks
- Never claim a check passed unless it was actually executed
- Report exact commands, results, and any checks that were not run

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
