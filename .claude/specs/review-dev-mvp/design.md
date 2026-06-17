# review.dev MVP — Design

Ported from [SPEC.md](../../../SPEC.md) Draft 4. Sister files: [requirements.md](requirements.md), [tasks.md](tasks.md), [diagrams.md](diagrams.md).

## Architecture

Each repo gets its own SQLite DB and its own `reviewdev serve` process. The Claude Code skill shells out to `reviewdev publish`, which talks to the server for the current repo over HTTP. Every successful publish creates a new revision row.

```
Claude Code (/publish-review)
        │ shells out
        ▼
reviewdev publish  (one-shot, cwd-rooted)
  ├─ resolve repo root from cwd
  ├─ read <repo>/.reviewdev/port
  ├─ git fetch origin <base>
  ├─ git diff $(merge-base HEAD origin/<base>)..HEAD
  ├─ ~/.claude/projects/<slug>/<session>.jsonl (+subs)
  ├─ gh pr view --json url (best-effort)
  ├─ POST /api/pr → server creates revision N
  └─ trigger /api/pr/:id/rev/:n/generate (SSE)
        │ HTTP
        ▼
<repo>/.reviewdev/db.sqlite (WAL mode, BEGIN IMMEDIATE for publish writes)
        ▲
        │
reviewdev serve  (foreground, cwd-rooted, Hono on Bun, port 7891–7899)
        │
        ▼
browser → /pr/:id → /pr/:id/rev/<latest> (skeleton, SSE chapters arrive)
```

See [diagrams.md](diagrams.md) for full Mermaid flows: publish pipeline, user navigation, concurrent-publishes sequence, revision diff view.

### Source layout

A thin `src/cli.ts` dispatcher routes the `reviewdev` binary's subcommands. Each subcommand handler lives at `src/commands/<name>.ts` exporting a `CommandHandler` (`(args, io) => Promise<number>`). T1.1 lands `serve` and `publish` stubs at that path; T1.3 / T1.4 replace the stubs in place with the real implementations.

## Data Model

One SQLite DB per repo at `<repo-root>/.reviewdev/db.sqlite`. Path is gitignored on first `reviewdev publish`. Schema versions tracked in a `meta` table; numbered migrations in `migrations/NNN_*.sql` apply forward-only on `reviewdev serve` start.

| Table | Key columns | Notes |
|---|---|---|
| `pulls` | `id`, `branch`, `base`, `title`, `github_url`, `status`, `created_at`, `updated_at` | One per branch. |
| `revisions` | `id`, `pull_id`, `number`, `git_head_sha`, `git_base_sha`, `diff_hash`, `created_at` | Unique on `(pull_id, number)`. `diff_hash` = hash of sorted hunk-id set; used to detect duplicate publishes. |
| `sessions` | `id`, `pull_id`, `agent`, `kind`, `transcript_path`, `cwd`, `started_at`, `ended_at`, `parent_session_id`, `compacted` | Scoped to PR (not revision) — sessions span revisions. `cwd` for branch correlation. |
| `hunks` | `id` *(content-hash)*, `revision_id`, `pull_id`, `file_path`, `start_line`, `end_line`, `content`, `kind`, `session_id`, `agent`, `confidence`, `generated` | `id = SHA-256(file_path + "\n" + literal hunk content)`. Same hash can appear in multiple revisions. |
| `chapters` | `id`, `revision_id`, `pull_id`, `marker`, `title`, `summary`, `order`, `inherited_from_chapter_id` | `inherited_from_chapter_id` points at the prior revision's chapter when the LLM reused it. Drives the diff view's chapter-delta. |
| `chapter_hunks` | `chapter_id`, `hunk_id`, `order` | Many-to-many within a revision. |
| `decisions` | `id`, `revision_id`, `session_id`, `ts`, `summary` | Extracted in the same LLM call as chapters. |
| `comments` | `id`, `revision_id`, `pull_id`, `target_kind`, `target_id`, `body`, `created_at` | Markdown body. Scoped to revision. No threading, resolution, or line-anchoring. |
| `approvals` | `id`, `revision_id`, `pull_id`, `chapter_id`, `approved_at`, `note` | Chapter-level signoff on a specific revision. |
| `usage` | `id`, `day`, `cost_usd`, `tokens_in`, `tokens_out`, `op` | One row per LLM call. |

**Indexes (minimum viable):**
- `hunks(revision_id)`, `hunks(pull_id)`, `hunks(file_path)`
- `chapters(revision_id)`, `chapter_hunks(hunk_id)` (the composite PK `chapter_hunks(chapter_id, hunk_id)` already serves `WHERE chapter_id = ?` via leading-column prefix scan; no separate `chapter_hunks(chapter_id)` index is needed)
- `comments(revision_id, target_kind, target_id)`
- `revisions(pull_id, number)` (unique)
- `approvals(revision_id, chapter_id)` (unique — one signoff per chapter per revision)
- `usage(day)`

### Writer invariants

These invariants live in app code; SQLite alone can't enforce them.

- **`chapter_hunks → hunks` joins must go through `chapters.revision_id`.** Hunks are keyed `(id, revision_id)` but `chapter_hunks` stores only `hunk_id`, so the natural `chapter_hunks JOIN hunks ON hunks.id = chapter_hunks.hunk_id` is ambiguous when the same content-hash recurs across revisions. Disambiguate via `JOIN chapters ON chapters.id = chapter_hunks.chapter_id AND chapters.revision_id = hunks.revision_id`. Adding the composite FK at the SQL level would require denormalising `revision_id` into `chapter_hunks` — chosen against because `chapter_id` already carries the revision.
- **Denormalised `pull_id` / `revision_id` columns must be derived from the owning row, not the request payload.** `hunks.pull_id`, `chapters.pull_id`, `comments.pull_id`, `approvals.pull_id`, `approvals.chapter_id`'s `revision_id` are denormalisations that enable index-backed queries. SQLite validates each FK independently and can't enforce "the hunk's revision belongs to the same pull." T1.5+ writers must look up the owning revision/chapter inside the same transaction and set the denormalised columns from there.
- **`pulls.updated_at` must be bumped on every write to the pull.** Its `DEFAULT` only fires at row insert; SQLite has no `ON UPDATE`. The `/pulls` index sorts and shows `updated_at`, so the `POST /api/pr` upsert (T1.5) must set `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` whenever it touches a pull (new revision, status change). Without that the column freezes at first-publish time and the index mis-sorts.

### Hunk identity

`SHA-256(file_path + "\n" + literal hunk content)`. Order-sensitive. Two purposes:

1. **Revision diffing.** Hunks in N but not N-1 = added. In N-1 but not N = removed. In both = unchanged.
2. **Chapter-inheritance hint.** The prompt for revision N is told which prior chapters' hunks all survived, with instructions to reuse titles/groupings.

There is no migration logic — hashes are reference data, not identity-preserving foreign keys.

## API Design

All endpoints served by `reviewdev serve` on the per-repo port. JSON for data endpoints, HTML for view endpoints, SSE for streaming.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe (T1.3). Returns `{ok: true, port, schema_version}` — `publish` uses it to confirm the server is up and on a compatible schema. |
| `GET` | `/pulls` | Index page — list open PRs (status, branch, title, updated_at, latest_revision_number). |
| `GET` | `/pr/:id` | Redirects to `/pr/:id/rev/<latest>`. |
| `GET` | `/pr/:id/rev/:n` | Pinned revision view (HTML, demo Concept 01). |
| `GET` | `/pr/:id/rev/:n/diff` | Revision diff view (HTML) — code delta + chapter delta vs `n-1`. |
| `GET` | `/api/pr/:id` | JSON for the latest revision (used by frontend). |
| `GET` | `/api/pr/:id/rev/:n` | JSON for a pinned revision. |
| `GET` | `/api/pr/:id/revisions` | List revisions in order. |
| `GET` | `/api/pr/:id/comment-counts` | Counts by revision — drives the header pill. |
| `POST` | `/api/pr` | Upsert pull + create revision (called by CLI). Returns `{pull_id, revision_number, url}`. |
| `POST` | `/api/pr/:id/rev/:n/comments` | Add a comment (hunk/chapter/PR-scoped). |
| `POST` | `/api/pr/:id/rev/:n/chapters/:cid/approve` | Approve a chapter on a revision. |
| `POST` | `/api/pr/:id/rev/:n/generate` | SSE stream — chapter generation + decisions. |
| `POST` | `/api/pr/:id/rev/:n/ask` | SSE stream — ask-the-author Q&A (P1.3). |

**SSE event shape:**
```
event: chapter
data: { "id": "...", "marker": "§ 03 · Tradeoff", "title": "…", "summary": "…", "order": 3, "hunk_ids": [...] }

event: decision
data: { "ts": "…", "summary": "…" }

event: done
data: {}

event: error
data: { "message": "…", "code": "rate_limit | over_cap | …" }
```

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Process model | Two CLIs: foreground `reviewdev serve` + one-shot `reviewdev publish` | Clear separation. Publish errors fast if serve isn't running. |
| DB scope | Per-repo `<repo-root>/.reviewdev/db.sqlite` | No P0 feature uses cross-repo. Simpler isolation and routing than a global DB. |
| Revision model | Each publish = immutable revision row; no comment migration | Drops 4 hard correctness surfaces (hash-based migration, locked chapters, orphan handling, SSE supersedes). Diff-view is the link between revisions. |
| Duplicate detection | `diff_hash` matches latest → return existing URL | Prevents accidental dup revisions when re-running publish without changes. |
| Chapter inheritance | Soft prompt-level hint, not explicit lock | LLM decides what to reuse based on hash-survivor signal. Less UI, less data model. |
| Hunk identity | `SHA-256(file_path + "\n" + literal content)` | Order-sensitive. Powers diffing + inheritance hints. Not a migration mechanism. |
| LLM call shape | Single combined call emitting `{chapters, decisions}` | 1 call instead of 2 parallel. Cuts cost ~40%, latency ~30%. |
| Model | `claude-sonnet-4-7` default, `REVIEWDEV_MODEL` override | Pinned; no implicit floating reference. |
| Streaming | SSE | Chapters render as they arrive; time-to-URL stays sub-2s. |
| Confidence v1 | All hunks `high` | Heuristic was on cut-list. Schema column exists for week 2 if dogfood reveals the gap. |
| Diff source | `git diff $(merge-base HEAD origin/<base>)..HEAD` after fetch | Auto-detect base from `refs/remotes/origin/HEAD`. Merges from base don't appear as authored changes. |
| Server lifecycle | Foreground, ports 7891–7899 probed; `REVIEWDEV_PORT` pins a single explicit port | No daemon; user runs `reviewdev serve` per repo (typically in tmux or launchd). `REVIEWDEV_PORT` is the escape hatch when the default range is exhausted. |
| Concurrency | No supersedes; both publishes get their own revision | Immutable-revisions makes concurrency trivially safe. |
| Cost guardrails | `usage` table; $5 soft warning; `REVIEWDEV_DAILY_CAP` hard cap | One env, one warning, one row per call. No third-party billing service. |
| API key | `ANTHROPIC_API_KEY` only | No config file, no first-run prompt. Missing key falls back to file-based chapters. |
| Distribution | `bun install -g reviewdev`; postinstall installs skill non-destructively | One command. No `install-skill --force` subcommand — user runs the manual command if they want to overwrite. |
| Migrations | Numbered `migrations/NNN_*.sql`, applied on serve start, WAL mode + `BEGIN IMMEDIATE` for writes | Standard forward-only. Personal tool — no rollback path needed. |
| Tests | Two fixture suites land before week 1 ships (hash+diff, chunk-merge) | The silently-corruptible surfaces dogfood can't catch. |
| Chunking large diffs | File-boundary split at ~80k tok/chunk; per-chunk chapter candidates; cheap Haiku merge pass for global 3–7 chapters | Files never split across chunks (per-file context preserved). Invariant: every input hunk lands in exactly one chapter. Full spec in [SPEC.md](../../../SPEC.md#chunking-strategy-for-large-diffs). |

## Security Considerations

- **Single user, localhost only.** No auth surface. The server binds to `localhost` (not `0.0.0.0`).
- **No telemetry.** `usage` table is local-only.
- **API key in env, never persisted.** `ANTHROPIC_API_KEY` never written to disk by reviewdev.
- **`gh` output trust.** `gh pr view --json url` output is interpolated into HTML as a link; treat as untrusted and URL-encode. Realistically the user controls the GitHub remote, so the threat surface is small.
- **Diff content in prompts.** Anthropic API receives the full diff (P0.3). Same trust posture as Claude Code itself — the user is sending their own code to their own LLM provider.
- **SQLite file permissions.** `<repo>/.reviewdev/db.sqlite` inherits cwd permissions. No additional scoping in v1.

## Failure Modes

See [SPEC.md](../../../SPEC.md) §Failure modes. Every row has at least one of: a test, an error path, or a non-silent user signal.

## Open Questions

| # | Question | Owner |
|---|---|---|
| OQ.1 | Phase 2 deployment target: Fly, Render, Vercel? | Defer until Phase 1 has earned its place. |
| OQ.2 | UX for marking a session as "exploratory" vs "main" — schema covers via `sessions.kind`, surfacing TBD. | Engineering, week 1 if P1.5 is built. |
