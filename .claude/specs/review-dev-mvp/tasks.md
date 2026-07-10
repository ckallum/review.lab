# review.dev MVP — Tasks

Ported from [SPEC.md](../../../SPEC.md) Draft 4. Sister files: [requirements.md](requirements.md), [design.md](design.md), [diagrams.md](diagrams.md).

Each task is sized to be one logical commit / one PR. `/execute` SPEC mode should walk these in order. Tasks within a phase can be parallelised where dependencies allow.

## Phase 1 — Foundation (Week 1)

- [x] **T1.1 — Project scaffold.** `bun init`, add Hono, Vitest, TypeScript, prettier. `package.json` exposes a single `reviewdev` binary with `serve` and `publish` as subcommands dispatched by `src/cli.ts` (matches the architecture in [design.md](design.md#architecture)). Tests pass on a stub. Also delivers three load-bearing artifacts later tickets depend on: `CLAUDE.md` (project conventions), `.prettierignore` + `format` / `format:check` scripts (scope prettier away from spec docs), and the `src/commands/<name>.ts` layout that T1.3 / T1.4 drop their real implementations into.
- [x] **T1.2 — SQLite schema + migrations system.** `migrations/001_initial.sql` lays down the 10 data-model tables from [design.md](design.md#data-model) (`pulls`, `sessions`, `revisions`, `hunks`, `chapters`, `chapter_hunks`, `decisions`, `comments`, `approvals`, `usage`) plus indexes. `src/db/migrate.ts` applies forward-only on serve start; `openDb` sets WAL mode + foreign-key enforcement; each migration runs inside its own `BEGIN IMMEDIATE` transaction so a partial failure rolls back. The `meta` migration tracker is created by `migrate.ts` itself — it belongs to the migration system, not the data model.
- [x] **T1.3 — `reviewdev serve` skeleton.** Hono server with port probe (7891–7899), writes chosen port to `<repo>/.reviewdev/port`. `GET /health` returns `{ok: true, port: N, schema_version: N}`. Foreground process, structured logs to stdout. Server binds `127.0.0.1` (the IPv4 address, not the `localhost` hostname — see design.md § Security); migrations apply forward-only on start (reuses T1.2 `openDb`/`applyMigrations`); `schema_version` reads `MAX(version)` from `meta`. `REVIEWDEV_PORT` overrides the probe with a single explicit port (the escape hatch named in the all-ports-busy error, per SPEC.md § failure modes).
- [x] **T1.4 — `reviewdev publish` core.** Resolve repo root from cwd; read port file + confirm the server via `GET /health` on `127.0.0.1` (else the `no server for <repo>` error); auto-detect base branch (`origin/HEAD` → `gh` → main/master); `git fetch` with 60s throttle; `git diff $(merge-base HEAD origin/<base>)..HEAD`; parse hunks; compute `SHA-256(file_path + "\n" + content)` per hunk. `hunks.kind` enum settled to `add`/`del`/`mod` (#9). Upload + revision creation is T1.5.
- [x] **T1.5 — Revision creation + duplicate detection.** `POST /api/pr` upserts pull, computes `diff_hash`, checks against latest revision, inserts new revision row or returns existing URL. Returns `{pull_id, revision_number, url}`. Folded in three T1.4 follow-ups that live on this surface: the gh base-ref seam injected into `resolveDiff` with its hermetic test (#22), publish's stdout reduced to the result URL with diagnostics routed to stderr (#20), and the preflight probe distinguishing a refused/absent server from a reachable-but-unhealthy one (#21).
- [x] **T1.6 — Hash + revision-diff test suite (`hunks.test.ts`).** 30+ property cases on the hash function. 10+ fixture cases for revision diffing (hunk-add, hunk-remove, file-rename, ordering changes). Must pass before T1.7 merges. Landed the pure `diffRevisions(prev, next) → {added, removed, unchanged}` core in `src/diff.ts` (the surface the fixtures exercise, keyed by content-hash id) so the NFR-6 suite has something to test; T1.10 renders it. Property cases hand-rolled (no `fast-check`) with known-answer digests pinning the exact hash construction; `diff.test.ts` keeps the T1.4 proportionate parser coverage.
- [ ] **T1.7 — Demo HTML extraction.** Pull the local reference demo HTML (Concept 01; source path tracked outside the repo), strip tab nav and concepts 02–06, replace numeric `conf 0.94` with word bands. Land at `web/index.html`. Parameterise every hardcoded string to fetch from `/api/pr/:id/rev/:n`.
- [ ] **T1.8 — File-based chapter fallback.** Group hunks by top-level directory, secondary by extension. Emit 3–7 chapters with marker numbering. No LLM. Used when `ANTHROPIC_API_KEY` is unset.
- [ ] **T1.9 — `/pr/:id` + `/pr/:id/rev/:n` routes.** Serve the demo HTML, hydrate from `/api/pr/:id/rev/:n` JSON. Latest revision is the default landing.
- [ ] **T1.10 — Revision diff view (`/pr/:id/rev/:n/diff`).** Render code delta (hunk added/removed/unchanged badges) and chapter delta (added/dropped/inherited/regenerated). `n=1` falls back to single-revision view.
- [ ] **T1.11 — SLA measurement spike.** Run chapter generation on 5 real 50-hunk PRs against Sonnet 4-7. Record TTFT + total-render-time. Commit the SLA number into [requirements.md](requirements.md#non-functional-requirements) NFR-2. Block week 2 on this.

## Phase 2 — LLM + Dogfood (Week 2)

- [ ] **T2.1 — Anthropic API integration.** `src/llm/anthropic.ts` — streaming, JSON-mode `{chapters, decisions}`. Pin to `REVIEWDEV_MODEL ?? "claude-sonnet-4-7"`. Recorded-fixture interface for tests.
- [ ] **T2.2 — Chapter-inheritance prompt extension.** Prompt receives prior revision's chapter titles + which of its hunks survived (by hash). Instructs reuse where every underlying hunk is unchanged. Sets `inherited_from_chapter_id` when the model reuses.
- [ ] **T2.3 — Chunked merge pass.** When input diff > ~150k tokens, chunk by file with size budget; run chapter calls in parallel; merge pass unifies chapters with global numbering. All hunks must be covered; markers must be unique.
- [ ] **T2.4 — Chunk-merge test suite (`chunk-merge.test.ts`).** 5+ recorded large-diff cases. Inheritance-hint correctness too. Must pass before T2.5 merges.
- [ ] **T2.5 — SSE `/api/pr/:id/rev/:n/generate`.** Stream chapters and decisions as they arrive. Browser hydrates skeleton from EventSource. Per-revision active stream registry (for diagnostics, not supersedes).
- [ ] **T2.6 — Per-hunk attribution.** `git blame --follow` per hunk line; commit-trailer parsing (`Co-authored-by`); trailer beats blame. Mixed-author majority-wins. Generated-file detection via `.gitattributes linguist-generated` + builtin extensions (`*.snap`, `package-lock.json`, `dist/`).
- [ ] **T2.7 — Cost guardrails.** `usage` table writes per LLM call. Soft warning at $5/day. `REVIEWDEV_DAILY_CAP` hard cap that fails publish before the LLM call.
- [ ] **T2.8 — Begin dogfooding.** First reviewdev PR after T2.5 goes through reviewdev. Log every "this is rough" moment into a follow-up sweep at end of week.

## Phase 3 — Skill + Session Bay (Week 3)

- [ ] **T3.1 — `SKILL.md` for `/publish-review`.** Final wording, allowed-tools, descriptor that maps to the user's natural language triggers. End-to-end test from a real Claude Code session.
- [ ] **T3.2 — `bun install -g` postinstall.** Lays down `~/.claude/skills/review-dev/SKILL.md` non-destructively. If exists, prints the manual override command.
- [ ] **T3.3 — Transcript reader.** Parse `~/.claude/projects/<slug>/<session>.jsonl`. Follow sub-agent / Task sessions via parent references. Extract tool calls, user messages, agent reasoning, per-entry `cwd`.
- [ ] **T3.4 — Compacted-session handling.** Detect `/compact` and `/clear` in transcripts. Mark `sessions.compacted=1`. Skip decisions extraction for compacted sessions. Surface a "compacted" badge in the session bay.
- [ ] **T3.5 — Session ↔ branch correlation.** Join sessions by `cwd` + commit times on the branch. Surface only sessions that plausibly touched the current branch.
- [ ] **T3.6 — Session bay UI.** Right-rail Concept 04 panel from the demo. Lists sessions with kind labels (Execute / Review / Ship), last active, "Resume" button copying `claude --resume <id>`.
- [ ] **T3.7 — `/resume-review` skill (optional).** Reads the most recent open PR in the current repo's DB and prints/copies the `claude --resume` command.

## Phase 4 — Polish (Week 4)

- [ ] **T4.1 — Ask-the-author.** `POST /api/pr/:id/rev/:n/ask` SSE. Request body = chapter hunks + summary + question. Server filters transcript to tool calls and messages touching files in this chapter; passes the slice to the model. Response persists as a comment scoped to the chapter and revision.
- [ ] **T4.2 — Decisions list UI.** Right-rail rendering of `decisions` rows for the current revision. Hidden for compacted sessions.
- [ ] **T4.3 — Comment-counts pill.** `GET /api/pr/:id/comment-counts` returns counts by revision. Latest-revision header shows "N comments on earlier revisions · view" → revision picker modal.
- [ ] **T4.4 — README + distribution.** Public GitHub repo. README covers install, `ANTHROPIC_API_KEY` setup, daemonising `reviewdev serve`, troubleshooting (port conflict, no API key, `gh` missing). Single-command install via `bun install -g reviewdev`.
- [ ] **T4.5 — Final dogfood pass.** Every PR for the next week goes through reviewdev. Tracking sheet for the success metrics. Sweep findings into a follow-up issue list for the month-long use period.

## Phase 5 — Use it (Month after week 4 ships)

- [ ] **T5.1 — Pause feature work.** Every personal PR goes through reviewdev. Track lagging success metrics from [requirements.md](requirements.md#non-functional-requirements).
- [ ] **T5.2 — Confidence heuristic decision.** Build P1.7 only if dogfood reveals the gap. Default: don't build.
- [ ] **T5.3 — Phase 2 readiness check.** Has Phase 1 earned its place? If yes, begin `reviewdev/action@v1` planning. If no, more dogfood.

## Cut order if week 1–3 slips

1. Confidence heuristic (P1.7, already deferred)
2. Decisions list UI (T4.2)
3. Multi-agent attribution (T2.6 — fall back to "everyone not me" = "human")
4. Ask-the-author (T4.1)
5. Diff between arbitrary revision pairs (P1.6 — only rev N vs N-1 in v1, already P1)

Even with all of those cut, the loop is: write code → `/publish-review` → browser opens → read revision → approve or comment. That's the MVP.
