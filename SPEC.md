# review.dev MVP — local PR review for agent-authored code
*Draft 4 · May 2026 · Callum Ke*

## TL;DR
Build a local PR review surface that runs alongside GitHub. A Claude Code skill publishes the current session's PR to a per-repo local server (`localhost:7891`, falling back upward in 7891–7899) backed by SQLite. Each `reviewdev publish` creates an immutable **revision** with its own chapters and comments; revisions are linked by a code-and-chapter diff view. The reviewer opens a browser tab, reads the PR as a story with per-hunk agent attribution, and approves chapters or leaves comments. Phase 2 packages the same pipeline as a GitHub Action.

GitHub stays the source of truth. review.dev is the reading layer.

---

## Problem Statement
You write most of your code with Claude Code now. The PRs you open are large, well-structured, and unreadable on GitHub's review surface — a flat diff with no provenance. The *story* of why each section exists, which agent wrote what, and how confident the agent was, is gone the moment the diff renders. Reading your own PRs as if you didn't write them is the core friction.

## Goals
1. **Read PRs as a story, not a diff.** Open the PR and see chapters (Why → Approach → Tradeoffs → Schema → API → Tests → Rollout) before a line of code. Chapters span files, not the other way around.
2. **Provenance per hunk.** Every hunk shows which agent wrote it (Claude, cursor-tab, you-by-hand). Confidence rendering deferred until week 2.
3. **Immutable revisions.** Each publish creates a snapshot. Comments live on the revision they were left on. A revision-to-revision diff view shows what changed in code and chapters since the last publish.
4. **One-shot publishing from Claude Code.** `/publish-review` returns a URL in under 2 seconds; the rendered review is fully readable within a measured SLA on a 50-hunk PR.
5. **Zero infrastructure.** No accounts, no Docker, no cloud. `bun install -g reviewdev`, then `/publish-review`.
6. **GitHub stays canonical.** review.dev links out, never replaces. PR description, merge, and CI all stay on GitHub.

## Non-Goals (MVP)
1. **Multi-user.** Single-user, localhost only. No auth.
2. **Behavioral diff sandbox** *(Concept 05).* Defer.
3. **Full replay scrubber** *(Concept 06).* A chronological decisions list is enough.
4. **Audience switching beyond engineer** *(Concept 03).*
5. **Real-time collab.** Comments and approvals are local. No GitHub sync — not even an export button.
6. **Self-hosted distribution.** Public repo, but not packaged for others' use.
7. **Uncommitted changes.** Publish reflects committed state on the branch.
8. **Cross-repo dashboard.** Each repo is its own world.
9. **Confidence scoring in week 1.** All hunks render at `high`. Heuristic added in week 2 only if dogfood reveals the gap.
10. **Comment migration across revisions.** Comments are immutable on their revision. The revision diff view + a header pill ("4 comments on earlier revisions") is the discoverability story.
11. **Diff between arbitrary revision pairs.** v1 only diffs revision N against N-1.

---

## Architecture

Each repo gets its own SQLite DB and its own `reviewdev serve` process. The Claude Code skill shells out to `reviewdev publish`, which talks to the server for the current repo over HTTP. Every successful publish creates a new revision row.

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code session                                    │
│  /publish-review  ◀─── ~/.claude/skills/review-dev/     │
└────────────────┬────────────────────────────────────────┘
                 │ shells out
                 ▼
┌─────────────────────────────────────────────────────────┐
│  reviewdev publish  (one-shot, cwd-rooted)              │
│  ├─ resolve repo root from cwd                          │
│  ├─ read <repo>/.reviewdev/port                         │
│  ├─ git fetch origin <base>                             │
│  ├─ git diff $(merge-base HEAD origin/<base>)..HEAD     │
│  ├─ ~/.claude/projects/<slug>/<session>.jsonl (+subs)   │
│  ├─ gh pr view --json url (best-effort)                 │
│  ├─ POST /api/pr (server creates revision N)            │
│  └─ trigger /api/pr/:id/rev/:n/generate (SSE)           │
└────────────────┬────────────────────────────────────────┘
                 │ HTTP
                 ▼
        <repo>/.reviewdev/db.sqlite
                 ▲
                 │
┌─────────────────────────────────────────────────────────┐
│  reviewdev serve  (foreground, cwd-rooted)              │
│  localhost:7891–7899  (Hono on Bun)                     │
│  ├─ GET  /pulls                                         │
│  ├─ GET  /pr/:id                  → latest revision     │
│  ├─ GET  /pr/:id/rev/:n           → pinned revision     │
│  ├─ GET  /pr/:id/rev/:n/diff      → diff vs rev (n-1)   │
│  ├─ GET  /api/pr/:id/revisions    → list                │
│  ├─ POST /api/pr                  → create revision     │
│  ├─ POST /api/pr/:id/rev/:n/comments                    │
│  ├─ POST /api/pr/:id/rev/:n/chapters/:cid/approve       │
│  ├─ POST /api/pr/:id/rev/:n/generate  → SSE             │
│  └─ POST /api/pr/:id/rev/:n/ask       → SSE             │
└─────────────────────────────────────────────────────────┘
                 │
                 ▼
        open in browser
```

`reviewdev publish` returns a URL the moment the revision row + hunks are uploaded (sub-second). The browser opens to a skeleton view and a single LLM call streams `{chapters, decisions}` over SSE.

### Revisions

A **revision** is an immutable snapshot of a PR at the moment `reviewdev publish` was called. Each revision owns its own hunks, chapters, decisions, comments, and approvals. Nothing migrates across revisions; the link between them is the **revision diff view**.

Rules:

- **Each publish creates a new revision** with `number = max(prior) + 1`, unless the diff exactly matches the latest revision's hunks — in that case, no new revision is created and `publish` returns the latest URL. (Prevents accidental duplicate revisions when re-running publish without changes.)
- **The latest revision is the default view.** `/pr/:id` redirects to `/pr/:id/rev/<latest>`.
- **Old browser tabs pin to the revision they were opened on.** No supersedes, no flicker — the tab from yesterday keeps showing yesterday's revision until you reload.
- **Chapter inheritance is a soft prompt-level hint.** The chapter-generation call for revision N is shown the prior revision's chapter titles and which of its hunks (by content hash) still exist in N. The prompt instructs: *"reuse a title/grouping where every underlying hunk is unchanged; regenerate otherwise."* No explicit lock — the LLM decides.
- **Comments live on the revision they were left on.** A header pill on the latest revision ("4 comments on earlier revisions · view") opens a revision picker. No migration logic.

## Data Model (SQLite)

One DB per repo at `<repo-root>/.reviewdev/db.sqlite`. Path is gitignored on first `reviewdev publish`. Schema versions tracked in a `meta` table; numbered migrations in `migrations/NNN_*.sql` apply forward-only on `reviewdev serve` start. WAL mode enabled; publish writes use `BEGIN IMMEDIATE`.

| Table | Key columns | Notes |
|---|---|---|
| `pulls` | `id`, `branch`, `base`, `title`, `github_url`, `status`, `created_at`, `updated_at` | One per branch. |
| `revisions` | `id`, `pull_id`, `number`, `git_head_sha`, `git_base_sha`, `diff_hash`, `created_at` | `number` starts at 1; `diff_hash` = hash of the sorted hunk-id set, used to detect duplicate publishes. Unique on `(pull_id, number)`. |
| `sessions` | `id`, `pull_id`, `agent`, `kind`, `transcript_path`, `cwd`, `started_at`, `ended_at`, `parent_session_id`, `compacted` | Scoped to the PR, not a single revision. Sessions can span revisions. `cwd` used for branch correlation. |
| `hunks` | `id` *(content-hash)*, `revision_id`, `pull_id`, `file_path`, `start_line`, `end_line`, `content`, `kind`, `session_id`, `agent`, `confidence`, `generated` | `id` = `SHA-256(file_path + "\n" + literal hunk content)`. Used both for revision diffing and chapter-inheritance hints. Same hash can appear in multiple revisions. |
| `chapters` | `id`, `revision_id`, `pull_id`, `marker`, `title`, `summary`, `order`, `inherited_from_chapter_id` | `inherited_from_chapter_id` (nullable) points at the prior revision's chapter when the LLM reused it. Used for the revision-diff chapter view. |
| `chapter_hunks` | `chapter_id`, `hunk_id`, `order` | Many-to-many within a revision. |
| `decisions` | `id`, `revision_id`, `session_id`, `ts`, `summary` | Extracted in the same LLM call as chapters. |
| `comments` | `id`, `revision_id`, `pull_id`, `target_kind`, `target_id`, `body`, `created_at` | Markdown body. Scoped to the revision. No threading, no resolution, no line-anchoring in v1. |
| `approvals` | `id`, `revision_id`, `pull_id`, `chapter_id`, `approved_at`, `note` | Chapter-level signoff on a specific revision. |
| `usage` | `id`, `day`, `cost_usd`, `tokens_in`, `tokens_out`, `op` | One row per LLM call. |

### Hunk identity (for diff and inheritance)
Hunks are addressed by `SHA-256(file_path + "\n" + literal hunk content)`. The hash is order-sensitive. It serves two purposes:

1. **Revision diffing.** Hunks added in revision N (not in N-1 by hash) are flagged "added"; hunks gone in N (in N-1 by hash, not in N) are "removed"; matching hashes are "unchanged."
2. **Chapter-inheritance hints.** The chapter-generation prompt for revision N is told which prior chapters' hunks all survived (by hash), with instructions to reuse titles/groupings for those. New, regrouped, or partially-changed chapters regenerate.

There is no migration logic — hashes are reference data, not identity-preserving foreign keys.

### Revision diff view

`GET /pr/:id/rev/:n/diff` renders the diff between revision `n` and revision `n-1` (if `n=1`, falls back to the initial-publish view).

Shown:

- **Code delta.** Hunks added in `n`, hunks removed since `n-1`, hunks unchanged. Rendered with the same Concept 01 chrome but with diff badges.
- **Chapter delta.** Chapters new in `n`, chapters dropped since `n-1`, chapters inherited (linked back to their source), chapters with same title but different hunk membership.
- **Header.** `Revision n vs n-1 · <git_head_sha[:7]>`. Switch to "view rev n alone" with one click.

The diff view does *not* show comment additions — comments are scoped to a revision and the chapter-delta carries enough signal.

### Chunking strategy for large diffs

> **Deferred to P2 (2026-06-26).** For MVP a diff that exceeds the one-call budget (~150k input tokens) makes `reviewdev publish` **hard-error** with a clear message instead of chunking (one test pins the boundary). That ceiling sits far above the 50-hunk PRs a single author produces in a month of dogfood. The file-boundary chunking design below is preserved as the P2 plan for when real diffs hit it.

When the diff exceeds ~150k input tokens, the chapter prompt is split:

- **Boundary.** Split by file. A single file is never split across chunks — same boundary as `git diff`'s file-by-file output. Preserves per-file context for the model.
- **Size budget.** Pack files into chunks up to ~80k tokens of diff content per chunk, in file-listing order. A file larger than 80k tokens lands in its own chunk and is flagged as a warning in `reviewdev publish` output (the model may truncate).
- **Per-chunk call.** Each chunk gets the same chapter-generation prompt with `chunk_index` and `total_chunks` injected. The model returns chapter *candidates* scoped to its files.
- **Merge pass.** A final consolidation call (Haiku is acceptable here — cheap and fast) takes all candidates and emits the global 3–7 chapter set with marker numbering (`§ 01`, `§ 02`, …) and a merged decisions list. `chunk-merge.test.ts` asserts the invariant: every input hunk lands in exactly one chapter, markers are unique, decisions deduplicate.

Conflict resolution and metadata propagation are implementation concerns, not contract — the contract is the invariant.

---

## Diff source
`reviewdev publish` resolves the diff in this order:

1. `git fetch origin <base>` to avoid stale-origin footguns. Adds 1–3 seconds; skipped if the last fetch was under 60 seconds ago.
2. Auto-detect `<base>` from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `gh pr view --json baseRefName`, then `main`, then `master`.
3. `git diff $(git merge-base HEAD origin/<base>)..HEAD` so merges *from* the base branch into the working branch don't appear as authored changes.
4. Committed state only. Uncommitted or staged changes are ignored. If `git status --porcelain` is non-empty, publish prints a warning and continues with HEAD.

---

## Server lifecycle
`reviewdev serve` runs in the foreground, rooted at the current working directory's repo root. Each repo runs its own server. The serve process probes ports 7891–7899, binds the first free one, and writes the chosen port to `<repo-root>/.reviewdev/port`. `reviewdev publish` reads that file from the current cwd to find the right server.

If no server is running for the repo, `publish` errors out with: `reviewdev: no server for <repo>. Run 'reviewdev serve' in this repo first.`

No supersedes-on-concurrent-publish logic. Each publish creates its own immutable revision; SSE streams run to completion against their own revision. Two overlapping publishes simply produce revisions N and N+1 in some order — both readable, both queryable.

---

## API key & model

`ANTHROPIC_API_KEY` environment variable only. Model is `claude-sonnet-4-7` by default, override via `REVIEWDEV_MODEL`. If `ANTHROPIC_API_KEY` is unset:

- Chapter generation falls back to file-based grouping (group by top-level directory, secondary split by extension).
- Decisions extraction is skipped (it shares the chapter call).
- Ask-the-author is disabled with a tooltip pointing at setup.
- `reviewdev publish` prints: `ANTHROPIC_API_KEY not set — using file-based chapters. See README for setup.`

### Cost guardrails
Each LLM call records cost + token counts in the `usage` table. Before any LLM call:

- If `usage.cost_usd` sum for today is greater than $5 — print a warning, continue.
- If `usage.cost_usd` sum for today is greater than `REVIEWDEV_DAILY_CAP` (unset by default) — fail with a clear message.

---

## Requirements

### P0 — Must have for MVP
| # | Requirement | Acceptance criteria |
|---|---|---|
| **P0.1** | **Claude Code skill** | A `/publish-review` slash command invokes `reviewdev publish --cwd "$(pwd)" --session "$CLAUDE_SESSION_ID"`. Skill installed at `~/.claude/skills/review-dev/SKILL.md` by `bun install -g reviewdev`'s postinstall. If the file exists, postinstall skips and prints the manual override command. No `install-skill --force` subcommand. |
| **P0.2** | **CLI: `reviewdev publish`** | Resolves diff per §Diff source. Uploads to the per-repo server, which creates a new revision (or returns the existing URL if `diff_hash` matches latest). Returns a URL within 2s; rendered chapters complete within the measured SLA on a 50-hunk PR via SSE. Works standalone with no `$CLAUDE_SESSION_ID`; session-dependent features degrade gracefully. |
| **P0.3** | **Chapter generation + decisions** | Single Anthropic API call (`claude-sonnet-4-7`) outputs `{chapters: [3-7], decisions: [...]}`. Prompt receives the full diff content (**hard-errors above ~150k tokens — chunking deferred to P2**), the prior revision's chapter titles + which hunks survived, with instructions to reuse where unchanged. Streams via SSE. Falls back to file-based grouping (no decisions) if `ANTHROPIC_API_KEY` is unset. |
| **P0.4** | **Per-hunk attribution** (reduced for MVP) | Generated files (linguist-generated, lockfiles, `*.snap`, `dist/`) tagged `generated`, excluded from chapter prompts. Deleted-only hunks render with `kind=del` styling. Non-generated hunks labelled `human`. Full provenance (`git blame --follow` + `Co-authored-by` trailer, trailer-beats-blame, majority-wins) deferred to P2 / Lanes (2026-06-26). |
| **P0.5** | **Confidence display (week 1: stub)** | All hunks render at `confidence=high` in week 1. Column exists in the schema. UI renders low/medium/high words with red/amber/green colour bands. Heuristic deferred to P1.7 if dogfood reveals the gap. |
| **P0.6** | **Concept 01 view** | Browser renders the imported demo HTML landed in the repo at `web/index.html` (Concept 01 only — import source-of-truth note lives in `tasks.md` T1.7), data-driven from `/api/pr/:id/rev/:n`. Title, chapter sidebar, marker headings, file-pill spans, hunks with attribution chips and confidence bands. Skeleton renders before chapters stream in. Numeric `conf 0.94` replaced with word-band display. Concepts 02–06 stripped from the import. |
| **P0.7** | **GitHub link out** | If `gh pr view --json url` returns a URL, display "View on GitHub" in the header. Otherwise show the branch name. `gh` missing/unauthed swallowed silently. |
| **P0.8** | **Comments and approvals** | Stored on the revision they were left on. Markdown body, no threading, no resolution state, no line-anchoring. Header pill on the latest revision: "N comments on earlier revisions · view" → opens a revision picker. |
| **P0.9** | **Revision diff view** | `GET /pr/:id/rev/:n/diff` renders code delta and chapter delta between revision `n` and `n-1`. Hunks tagged added/removed/unchanged. Chapters tagged added/dropped/inherited/regenerated. For `n=1`, shows the same view as the initial revision (no prior to diff against). |
| **P0.10** | **API surface for navigation** | `GET /pulls` lists open PRs (status, branch, title, updated_at, latest_revision_number). `GET /api/pr/:id/revisions` lists revisions in order. Used by the index page and the revision picker. |

### P1 — Nice to have
| # | Requirement | Notes |
|---|---|---|
| **P1.1** | **Session bay** *(Concept 04)* | Right rail lists sessions correlated to this branch via `cwd` + recent commit times. Kind labels from session metadata. v1 follows only `$CLAUDE_SESSION_ID` + its sub-agent/Task sessions. Sessions span revisions; the bay shows them all. Compacted/cleared sessions show with a "compacted" badge. |
| **P1.2** | **Resume from review.dev** | "Resume" button generates a `claude --resume <session-id>` command and copies to clipboard. |
| **P1.3** | **Ask the author** | Per-chapter chat input. Request = chapter hunks + summary + question + a *relevant slice* of the session transcript. Streams via SSE. Stored as comments scoped to the chapter (and its revision) so the conversation persists. |
| **P1.4** | **Decisions list rendering** | Right rail in chapter view shows chronological decisions from the `decisions` table. Already emitted in P0.3's combined LLM call. Skipped visually for compacted sessions. |
| **P1.5** | **Branches** | Parallel exploratory branches surfaced as in Concept 04. Schema reuses `sessions.kind`; `exploratory` is a value. |
| **P1.6** | **Diff between arbitrary revision pairs** | UI affordance to diff any two revisions (e.g. rev 5 vs rev 2). Cheap once P0.9 ships — same logic, different inputs. |
| **P1.7** | **Confidence heuristic** | If dogfood reveals the gap: implement `confidence = file_path_risk × diff_size_factor`. Otherwise stay at `high`. |

### P2 — Phase 2 and beyond
| # | Requirement | Notes |
|---|---|---|
| **P2.1** | `reviewdev/action@v1` | GitHub Action runs the same pipeline on PR open/update. Posts a comment linking to the hosted review. |
| **P2.2** | **Hosted review.dev** | Same UI, deployed somewhere (OQ.1). Auth via GitHub OAuth. Multi-user. |
| **P2.3** | **Lanes** *(Concept 02)* | Real multi-agent attribution from agent platforms emitting session metadata. |
| **P2.4** | **Behavioral diff** *(Concept 05)* | Run before/after through ephemeral compute, replay user flows. |
| **P2.5** | **Audience switching** *(Concept 03)* | LLM-summarised views for PM, Support, Exec. |
| **P2.6** | **Full replay scrubber** *(Concept 06)* | Drag a handle across the agent's session, drop in at any moment. |
| **P2.7** | **Export comments to GitHub** | One-shot push of comments to the GitHub PR. |
| **P2.8** | **Cross-repo dashboard** | If wanted later, build a meta-server aggregating per-repo `db.sqlite` files. |

---

## Test Strategy

One fixture-based suite lands before week 1 ships: `hunks.test.ts`. *(Amended 2026-06-26: `chunk-merge.test.ts` deferred to P2 with the chunker — see §Chunking strategy. Was two suites, itself down from three after the comment-migration simplification.)*

| Suite | Covers | Style | Fixtures |
|---|---|---|---|
| `hunks.test.ts` | Hash function + revision diff correctness | Property tests over `(file_path, content) → hash`. Fixture cases: whitespace edit, line added in middle, line reordered, file renamed. Verify `rev N hunks vs rev N-1 hunks` produces correct added/removed/unchanged sets. | Synthetic diffs |
| ~~`chunk-merge.test.ts`~~ *(deferred to P2)* | Chunked LLM merge correctness — returns with the chunker (2026-06-26). The inheritance-hint correctness it covered is exercised by T2.2's tests in MVP. | — | — |

**LLM mocking discipline.** All LLM calls in tests go through a recorded-fixture interface. Real recordings curated from dogfood. CI never hits the live API.

**Test pyramid.** Roughly 70% integration (DB + HTTP + git + filesystem), 20% pure unit (hashing, parsing, prompt building), 10% E2E (full publish flow against a fixture repo, no real LLM).

**Tests that must pass in week 1 before any code ships:**
1. Hash function: 30+ property cases.
2. Revision diffing: 10+ cases covering hunk-add, hunk-remove, file-rename, ordering changes.
3. ~~Chunked merge: 5+ recorded large-diff cases including the inheritance-hint prompt extension.~~ *(Deferred to P2 with the chunker, 2026-06-26. MVP covers the large-diff path with a single hard-error boundary test.)*

---

## Failure modes

| Codepath | Realistic failure | Test? | Error path | User sees |
|---|---|---|---|---|
| `git fetch` | No network / wrong remote | ✓ integration | 10s timeout, then continue with stale base | Warning line: "fetch failed, using last-known base" |
| Anthropic API | Rate limit / 5xx | ✗ — add | Retry once with backoff, then surface | Banner on chapter pane: "chapter generation failed — retry" |
| Transcript missing | `$CLAUDE_SESSION_ID` points at deleted file | ✓ via standalone-mode tests | Continue without transcript | Session bay empty; no warning |
| Transcript compacted | `/compact` ran | ✓ via fixture | Mark session compacted, skip decisions | Compacted badge in session bay |
| `gh` missing/unauthed | Not installed or no token | ✓ via fixture | Silent — show branch name | No GitHub link in header |
| Port 7891–7899 all taken | Edge case | ✗ — add | Fail with: "no free port in 7891–7899, set REVIEWDEV_PORT" | Clear CLI error |
| SSE stream drops | Browser tab backgrounded; network hiccup | ✗ — manual | Browser reconnects on the same revision; server resumes | Brief "reconnecting…" flicker |
| Migration fails mid-run | Schema patch crashes | ✗ — manual | SQLite rolls back via transaction; serve exits non-zero | "Migration failed, see logs" |
| Duplicate publish (same diff) | User re-runs without commits | ✓ via integration | `diff_hash` matches latest revision; return existing URL | No new revision; same URL |
| Concurrent publish (different diffs) | Two terminals publish same branch | ✓ via integration | Both succeed; revisions assigned in commit order | Both revisions readable |
| Daily cost cap hit | $REVIEWDEV_DAILY_CAP reached | ✓ via unit | Publish fails before LLM call | "Daily cap reached, override via REVIEWDEV_DAILY_CAP=N" |
| Stale browser tab on old revision | User left a tab open from yesterday | ✗ — manual | Tab keeps showing that revision. Reload → latest. | Explicit, deterministic — by design |

No row has *both* "no test" AND "no error handling" AND "silent failure."

---

## Integration with Claude Code
The skill is the wedge.

```yaml
# ~/.claude/skills/review-dev/SKILL.md
---
description: |
  Publish the current branch to review.dev for narrative review. Use when
  the user says "review this PR", "publish to review", "stage for review",
  or finishes a feature and wants to read it before merging.
allowed_tools: [Bash]
---
When invoked:
1. Run: `reviewdev publish --cwd "$(pwd)" --session "$CLAUDE_SESSION_ID"`
2. The CLI prints a URL. Open it in the user's browser.
3. Done.
```

`reviewdev publish` reads `$CLAUDE_SESSION_ID` (when present) to locate `~/.claude/projects/<slug>/<session-id>.jsonl`. The transcript provides tool calls, user messages, agent reasoning, and `cwd` per entry (for branch correlation). Sub-agent / Task sessions follow via parent references.

### Optional second skill: `/resume-review`
Reverses the flow. From the review surface, "Resume from step 3" copies a `claude --resume` command. From Claude Code, `/resume-review` reads the most recent open PR in the current repo's `.reviewdev/db.sqlite` and continues the corresponding session.

---

## Success Metrics

**Leading (per-PR usage):**
- Time-to-URL under 2 seconds (p95) on a 50-hunk PR.
- Time-to-readable-chapters measured in week 1, target band 15–25 seconds (p95).
- 3–7 chapters generated per revision.
- Daily LLM cost under $5 (p95) during dogfood.

**Lagging (over weeks of personal use):**
- % of my own PRs read in review.dev before merge — target 80%+ within 2 weeks of week-4 ship.
- Time-to-merge on agent-authored PRs — target 30% reduction by week 4.
- Number of "wait, what does this PR even do?" moments — target zero.

---

## Open Questions
| # | Question | Owner |
|---|---|---|
| OQ.1 | Phase 2 deployment target: Fly, Render, Vercel? | Defer until Phase 1 has earned its place |
| OQ.2 | Marking a session as "exploratory" vs "main" — schema covers it via `sessions.kind`, but UX is unspecified. | Engineering — week 1 if P1.5 is built |

---

## Timeline & Phasing
**Week 1 — bootstrap.** `reviewdev serve` (Hono on Bun) + SQLite schema with numbered migrations + WAL + `reviewdev publish` writing revisions with file-based chapters. Demo HTML imported (Concept 01 only) and wired to `/api/pr/:id/rev/:n`. Revision diff view (P0.9) implemented. The hash+diff test suite lands before code merges.

**Week 2 — chapter generation + dogfood.** Wire the combined chapters+decisions API call with streaming and the chapter-inheritance prompt extension. **Measurement spike (runs first, needs T2.1):** chapter generation on 5 real 50-hunk PRs with Sonnet 4-7 — record TTFT + total-render-time, commit the SLA number (NFR-2); it gates T2.2–T2.8. MVP attribution is generated-file detection + a `human` default (full `git blame`/trailer provenance deferred to P2). **First dogfood:** reviewdev's own PRs go through reviewdev starting now.

**Week 3 — skill + session bay.** Skill triggers the CLI; postinstall lays it down. Transcript reading + sub-agent following. Session bay with `cwd`-based correlation. Compacted-session handling.

**Week 4 — sharpen.** Ask-the-author with transcript slicing, decisions list UI. README and `bun install -g reviewdev`. Public GitHub repo.

**Pause and use it for a month.** No new features. Every personal PR through review.dev.

**Phase 2 — GitHub Action.** Once Phase 1 has earned its place, package as a GitHub Action.

---

## Stack
- **Server:** Bun + Hono. Single binary per repo, fast cold start.
- **DB:** SQLite via `bun:sqlite`, WAL mode, `BEGIN IMMEDIATE` for publish writes. Numbered SQL migrations in `migrations/`, applied on `reviewdev serve` start.
- **Frontend:** Imported `review-dev-demo.html` (Concept 01 only), parameterised to fetch from `/api/pr/:id/rev/:n`. Streaming via EventSource/SSE. Vanilla JS.
- **LLM:** Anthropic API direct. Single combined call emitting `{chapters, decisions}` via streaming JSON. Diffs over the one-call budget (~150k tokens) hard-error in MVP (chunking + merge pass deferred to P2). Chapter-inheritance hint as a prompt extension.
- **Testing:** Vitest. One fixture-based suite (hash+diff) in week 1; chunk-merge deferred to P2.
- **Distribution:** `bun install -g reviewdev`. Postinstall lays down the skill (non-destructive).
- **Telemetry:** None. The `usage` table is local-only for cost guardrails.

## What I'd cut to ship faster
If week 1–3 slips, drop in this order:
1. **Confidence heuristic** (P1.7 — already deferred).
2. **Decisions list UI** (P1.4 — data is emitted free with chapters; just hide the rail).
3. **Multi-agent attribution** (P0.4 — "everyone not me" is "human"). *Now the MVP default (2026-06-26), not a contingency.*
4. **Ask the author** (P1.3 — most expensive P1).
5. **Diff between arbitrary revision pairs** (P1.6 — only rev N vs N-1 in v1; this is already P1).

Even with all of those cut, the loop is: write code → `/publish-review` → browser pops → read story-shaped revision → approve or comment. New revision when you push again. That's the MVP.

---

## Phase 2 sketch — GitHub Actions
```yaml
# .github/workflows/review-dev.yml (consumer side)
name: review.dev
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: reviewdev/action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          host: https://app.review.dev
          token: ${{ secrets.REVIEWDEV_TOKEN }}
```

---

## Open follow-ups
After this spec lands:
- **Engineering ticket breakdown** — slice P0 into ~10 implementation tickets.
- **Skill content** — write the actual `SKILL.md` for `/publish-review`.
- **Demo HTML import** — extract Concept 01 from the local reference demo (source path tracked outside the repo) into this repo at `web/index.html`. The import target is the contract; the source path is a local implementation detail.
- **Refresh diagrams.md** — Draft 4 invalidates the chapter-lifecycle state machine (locked/orphaned are gone) and the supersedes sequence diagram. New diagrams needed: revision lifecycle, revision-diff view, chapter-inheritance LLM call.
- **Stakeholder pitch** — if Phase 2 becomes real.
