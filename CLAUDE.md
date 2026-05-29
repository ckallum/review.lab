# review.dev — repo conventions

Local PR review surface for agent-authored code. Spec is the contract: [SPEC.md](SPEC.md) (narrative), [.claude/specs/review-dev-mvp/](.claude/specs/review-dev-mvp/) (requirements, design, tasks, diagrams). Phase 1 walks ticket-by-ticket — per-ticket branch (`feat/t<phase>.<ticket>-<slug>`), per-ticket PR.

## Stack

Bun (≥ 1.3) runtime. Hono server. SQLite via `bun:sqlite`. Vitest for tests. Prettier for formatting. No Node, no npm in the runtime path — `bun install`, `bun run`, `bun test`-equivalent via Vitest.

## Conventions

These are the principles surfaced during T1.1 / PR #4. Each one is the abstract version of a real mistake. Read them before scaffolding new tools or writing tests.

### Scope your tooling before its first invocation
Anything that walks the filesystem — prettier, eslint, biome, codemods, find-and-replace scripts — gets an explicit `*ignore` file or include-glob *before* you run it the first time. The default behaviour of these tools is "everything," which during T1.1 reformatted 40+ files outside scope including spec docs and harness skills. Same rule covers package defaults: audit them against the spec (`bun init`'s default `"private": true` would have blocked the `bun install -g reviewdev` distribution path in FR-P0.1).

### Exit codes are part of the contract
A handler that didn't do its job returns non-zero. Stubs that print "not yet implemented" return `1`, not `0`. Anything else silently composes through `cmd && next-step` in the user's shell and gives every caller a wrong answer. The `runServe` / `runPublish` stubs in `src/commands/` set the pattern: stderr message + return 1.

### Tests describe contracts, not implementation accidents
If a routing test would break when a co-located implementation lands real code, the test is testing the wrong thing. Use dependency injection: `main()` in `src/cli.ts` accepts an injectable `commands: CommandMap` so routing tests use `vi.fn()` spies to assert "cmd → handler called with the right rest args + io" — independent of what any handler happens to print. Stub-specific behaviour lives in its own `describe()` block, separate from the dispatch contract.

### Spec is the contract — surface drift, don't silently rebuild
SPEC.md, requirements.md, design.md, and tasks.md must agree. When you find them in tension during build, either propose a spec update (Draft N+1) or fix the code to match the spec. tasks.md T1.1 wording was sharpened against design.md in PR #4 Round 1 — the two had drifted on whether `serve` / `publish` are subcommands of one binary or two separate binaries (they're subcommands). The fix path is *spec follows ground truth* once design.md is the more rigorous statement; never silently let the code diverge from the contract.

### Update side state before drafting claims about it
The `/ship` claim-vs-diff grep catches missing identifiers in the diff. It does *not* catch claims like "tasks.md updated" or "T1.1 checkbox flipped" — those need the action to happen *before* the body is drafted. Order: write the change → commit → then write the PR body that references it.

## Workflow loop

Per-ticket: `/execute spec:review-dev-mvp` walks tickets in order. For each ticket, `/ship` opens the PR (review + tests + body). After review feedback lands, `/receiving-pr-feedback <pr>` processes it. The Pre-PR Gates in `/ship` (size, test-presence, spec-contract, claim-vs-diff) are advisory but generally worth heeding.

PR-only mode (`/ship pr`) is for docs / config / skill-only changes where the full test + simplify + review gauntlet is overkill.

## Personal-path and secret hygiene

Local pre-commit and pre-push hooks block personal filesystem paths, the author's username, and secrets (gitleaks). The blocked patterns are enumerated at `.git/info/PREVENTION.md`. Never `--no-verify`. If a hook blocks, reword the line — the hook is the prevention mechanism, not an obstacle to bypass.

## Writing prose

The user-level CLAUDE.md (Projects/.claude/CLAUDE.md) covers prose conventions for commit messages, PR bodies, READMEs, and docs. Key rules: concrete anchor per paragraph (file name, ticket ID, number), plain words, no `delve` / `leverage` / `seamless`, no `it's important to note`. Code is exempt — sterile is correct there.
