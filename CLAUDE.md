# review.dev — repo conventions

Local PR review surface for agent-authored code. Spec is the contract: [SPEC.md](SPEC.md) (narrative), [.claude/specs/review-dev-mvp/](.claude/specs/review-dev-mvp/) (requirements, design, tasks, diagrams). Phase 1 walks ticket-by-ticket — per-ticket branch (`feat/t<phase>.<ticket>-<slug>`), per-ticket PR.

## Stack

Bun (≥ 1.3) runtime. Hono server. SQLite via `bun:sqlite`. Vitest for tests, invoked via `bun --bun vitest` so workers stay inside Bun's runtime and can resolve `bun:sqlite` (don't drop the `--bun` flag in `package.json` scripts). Prettier for formatting. No Node, no npm in the runtime path — `bun install`, `bun run`.

## Source layout

`src/cli.ts` dispatches subcommands to `src/commands/<name>.ts` (each a `CommandHandler`) and owns the shared `fail(io, err)` exit-1 contract. Cross-command building blocks live as flat modules under `src/`: `src/repo.ts` (the `.reviewdev` path/port layout + `serverOrigin` loopback URL), `src/log.ts` (the `logLine` JSON envelope, written to a caller-chosen stream), `src/db/migrate.ts` (schema + migration runner), `src/db/revisions.ts` (the `POST /api/pr` writer: pull upsert, `diff_hash` duplicate detection, revision + hunk insert — T1.5), `src/diff.ts` (pure unified-diff parser + `hunkId` / `diffHash` SHA-256 hashing + `diffRevisions` content-hash revision delta + the canonical `dedupeHunks` — T1.6), `src/chapters.ts` (the no-LLM `fileBasedChapters` grouping — top-level dir → secondary extension → 3–7 `§ NN` chapters — plus the `insertChapters` writer, persisted inside the `createRevision` transaction — T1.8), and `src/git.ts` (the `GitRunner` seam + git operations: base detection, throttled fetch, merge-base diff). `serve` and `publish` both compose these rather than re-spelling paths or git calls — `publish`'s `resolveDiff` resolves the diff and `uploadRevision` POSTs it to the per-repo server.

The frontend lives under `web/`: `web/index.html` is the imported Concept 01 demo (T1.7), data-driven from a revision object — `renderRevision(data)` builds the DOM, `confidenceBand()` maps confidence to a low/medium/high word band (FR-P0.5), and `boot()` sources data as `window.__REVISION__` → `GET /api/pr/:id/rev/:n` → the bundled `DEMO_REVISION` fallback. Serving the page and wiring the live route is T1.9.

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

**Habit:** before touching one spec doc, grep the other three for any token, number, or symbol this change names. Five seconds; catches almost all surface drift. T1.2 hit two more instances: tasks.md's "9 tables" vs design.md's 10-row grid, and `hunks.kind` / `sessions.kind` enum vocabulary drifting across design.md prose ("added/removed"), FR-P0.4 (`del`), and T3.6 (`Execute` / `Review` / `Ship`). Sharpen the spec in the same PR the code change touches — don't ship a half-aligned contract.

### Update side state before drafting claims about it
The `/ship` claim-vs-diff grep catches missing identifiers in the diff. It does *not* catch claims like "tasks.md updated" or "T1.1 checkbox flipped" — those need the action to happen *before* the body is drafted. Order: write the change → commit → then write the PR body that references it.

## Workflow loop

Per-ticket: `/execute spec:review-dev-mvp` walks tickets in order. For each ticket, `/ship` opens the PR (review + tests + body). After review feedback lands, `/receiving-pr-feedback <pr>` processes it. The Pre-PR Gates in `/ship` (size, test-presence, spec-contract, claim-vs-diff) are advisory but generally worth heeding.

PR-only mode (`/ship pr`) is for docs / config / skill-only changes where the full test + simplify + review gauntlet is overkill.

## Gotchas

### Updating PR bodies on this repo
`gh pr edit --body-file` silently no-ops on this repo because of a `repository.pullRequest.projectCards` deprecation that fires inside the same GraphQL request. The CLI prints a warning and exits 0; the body never changes. Use `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@<file>` instead — it's REST, no GraphQL — and re-fetch `.body` afterwards to confirm the update took. The `/ship` and `/receiving-pr-feedback` skills both prescribe `gh pr edit` and need this workaround until the upstream gh CLI handles the deprecation cleanly.

## Personal-path and secret hygiene

Local pre-commit and pre-push hooks block personal filesystem paths, the author's username, and secrets (gitleaks). The blocked patterns are enumerated at `.git/info/PREVENTION.md`. Never `--no-verify`. If a hook blocks, reword the line — the hook is the prevention mechanism, not an obstacle to bypass.

## Writing prose

The user-level CLAUDE.md (Projects/.claude/CLAUDE.md) covers prose conventions for commit messages, PR bodies, READMEs, and docs. Key rules: concrete anchor per paragraph (file name, ticket ID, number), plain words, no `delve` / `leverage` / `seamless`, no `it's important to note`. Code is exempt — sterile is correct there.
