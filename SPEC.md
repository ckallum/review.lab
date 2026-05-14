# review.dev MVP — local PR review for agent-authored code
*Draft 2 · May 2026 · Callum Ke*

## TL;DR
Build a local PR review surface that runs alongside GitHub. A Claude Code skill publishes the current session's PR to a local server (`localhost:7891`, falling back upward in 7891–7899) backed by SQLite. The reviewer opens a browser tab, reads the PR as a story with per-hunk agent attribution and confidence, and approves chapters or leaves comments. Phase 2 packages the same pipeline as a GitHub Action.

GitHub stays the source of truth. review.dev is the reading layer.

---

## Problem Statement
You write most of your code with Claude Code now. The PRs you open are large, well-structured, and unreadable on GitHub's review surface — a flat diff with no provenance. The *story* of why each section exists, which agent wrote what, and how confident the agent was, is gone the moment the diff renders. Reading your own PRs as if you didn't write them is the core friction.

## Goals
1. **Read PRs as a story, not a diff.** Open the PR and see chapters (Why → Approach → Tradeoffs → Schema → API → Tests → Rollout) before a line of code. Chapters span files, not the other way around.
2. **Provenance per hunk.** Every hunk shows which agent wrote it (Claude, cursor-tab, you-by-hand) and a confidence band.
3. **One-shot publishing from Claude Code.** `/publish-review` returns a URL in under 2 seconds; the rendered review is fully readable within 15 seconds (p95, 50-hunk PR).
4. **Zero infrastructure.** No accounts, no Docker, no cloud. `bun install -g reviewdev`, then `/publish-review`.
5. **GitHub stays canonical.** review.dev links out, never replaces. PR description, merge, and CI all stay on GitHub.

## Non-Goals (MVP)
1. **Multi-user.** Single-user, localhost only. No auth.
2. **Behavioral diff sandbox** *(Concept 05 from the demo).* Defer.
3. **Full replay scrubber** *(Concept 06).* A chronological decisions list is enough.
4. **Audience switching beyond engineer** *(Concept 03).*
5. **Real-time collab.** Comments and approvals are local. No GitHub sync in MVP — not even an export button.
6. **Self-hosted distribution.** Public repo, but not packaged for others' use.
7. **Uncommitted changes.** Publish reflects committed state on the branch. If you want to review before merging, you must commit first.

---

## Architecture

The CLI splits into two processes: `reviewdev serve` (long-running, started once) and `reviewdev publish` (one-shot, called by the skill).

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code session                                    │
│  /publish-review  ◀─── ~/.claude/skills/review-dev/     │
└────────────────┬────────────────────────────────────────┘
                 │ shells out
                 ▼
┌─────────────────────────────────────────────────────────┐
│  reviewdev publish  (one-shot)                          │
│  ├─ git fetch origin <base>                             │
│  ├─ git diff $(merge-base HEAD origin/<base>)..HEAD     │
│  ├─ ~/.claude/projects/<slug>/<session>.jsonl (+subs)   │
│  ├─ gh pr view --json url                               │
│  ├─ writes hunks/sessions to SQLite                     │
│  └─ POSTs /api/pr/:id/generate-chapters (streams)       │
└────────────────┬────────────────────────────────────────┘
                 │ writes / talks to
                 ▼
        ~/.reviewdev/db.sqlite
                 ▲
                 │
┌─────────────────────────────────────────────────────────┐
│  reviewdev serve  (foreground, e.g. tmux or launchd)    │
│  localhost:7891  (Hono on Bun)                          │
│  ├─ GET  /pr/:id                  → the demo HTML       │
│  ├─ GET  /api/pr/:id              → JSON                │
│  ├─ POST /api/pr/:id/comments                           │
│  ├─ POST /api/pr/:id/chapters/:cid/approve              │
│  ├─ POST /api/pr/:id/chapters/:cid/lock                 │
│  ├─ POST /api/pr/:id/generate-chapters  (SSE stream)    │
│  └─ POST /api/pr/:id/ask           (SSE stream)         │
└─────────────────────────────────────────────────────────┘
                 │
                 ▼
        open in browser
```

`reviewdev publish` returns a URL the moment hunks are written (sub-second). The browser opens to a skeleton view and chapters stream in over SSE.

## Data Model (SQLite)

One global DB at `~/.reviewdev/db.sqlite`. Repos distinguish via the `repo` column. Schema versions are tracked in a `meta` table; numbered migrations in `migrations/NNN_*.sql` apply forward-only on `reviewdev serve` start.

| Table | Key columns | Notes |
|---|---|---|
| `pulls` | `id`, `repo`, `branch`, `base`, `title`, `github_url`, `status`, `created_at`, `updated_at` | One per (repo, branch) |
| `sessions` | `id`, `pull_id`, `agent`, `kind` *(execute/review/ship)*, `transcript_path`, `cwd`, `started_at`, `ended_at`, `parent_session_id`, `compacted` | `cwd` captured for branch correlation; `compacted=1` when transcript has been /clear-ed or compacted |
| `hunks` | `id` *(content-hash)*, `pull_id`, `file_path`, `start_line`, `end_line`, `content`, `kind` *(add/del/mod)*, `session_id`, `agent`, `confidence`, `generated` | `id` = SHA-256(file_path + sorted line content). Comments survive re-publishes via this hash. |
| `chapters` | `id`, `pull_id`, `marker` *("§ 03 · Tradeoff")*, `title`, `summary`, `order`, `locked` | `locked=1` once a user edits the title/summary or moves hunks. Locked chapters skipped on regenerate. |
| `chapter_hunks` | `chapter_id`, `hunk_id`, `order` | many-to-many |
| `decisions` | `id`, `session_id`, `ts`, `summary` | LLM-extracted at publish time |
| `comments` | `id`, `pull_id`, `target_kind`, `target_id`, `body`, `created_at` | Markdown body. Hunk-, chapter-, or PR-scoped. No threading, no resolved state, no line-anchoring in v1. |
| `approvals` | `id`, `pull_id`, `chapter_id`, `approved_at`, `note` | Chapter-level signoff |

### Hunk identity & comment migration
Hunks are addressed by a content hash (`SHA-256(file_path + sorted line content)`). On re-publish, if a hunk with a given hash reappears, its existing comments and approvals are reattached. If the hunk's content drifts at all, it becomes a new hunk and prior comments orphan onto the chapter (visible as "carried over from previous revision"). This is the lightweight, honest version of comment migration — fuzzy context matching is a Phase 2 improvement if orphaning bites.

---

## Diff source
`reviewdev publish` resolves the diff in this order:

1. `git fetch origin <base>` to avoid stale-origin footguns. Adds 1–3 seconds; skipped if the last fetch was under 60 seconds ago.
2. Auto-detect `<base>` from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `gh pr view --json baseRefName`, then `main`, then `master`.
3. `git diff $(git merge-base HEAD origin/<base>)..HEAD` so merges *from* the base branch into the working branch don't appear as authored changes.
4. Committed state only. Uncommitted or staged changes are ignored. If `git status --porcelain` is non-empty, publish prints a warning and continues with HEAD.

---

## Server lifecycle
`reviewdev serve` runs in the foreground. Users start it once — typically in a tmux pane, or under launchd if they want it always on. `reviewdev publish` errors out with a clear message if no server is up: `reviewdev: no server on 7891–7899. Run 'reviewdev serve' first.`

The serve process probes ports 7891 through 7899 and binds the first free one. The chosen port is written to `~/.reviewdev/port` so `publish` can find it. URLs in skill output read from that file.

---

## Requirements

### P0 — Must have for MVP
| # | Requirement | Acceptance criteria |
|---|---|---|
| **P0.1** | **Claude Code skill** | A `/publish-review` slash command invokes `reviewdev publish --cwd "$(pwd)" --session "$CLAUDE_SESSION_ID"`. Skill installed at `~/.claude/skills/review-dev/SKILL.md` by `bun install -g reviewdev`'s postinstall, which refuses to overwrite an existing file (use `reviewdev install-skill --force` to overwrite). |
| **P0.2** | **CLI: `reviewdev publish`** | Resolves diff per the §Diff source rules. Writes hunks and sessions to SQLite. Returns a URL within 2s of invocation; rendered chapters complete within 15s p95 on a 50-hunk PR via SSE streaming. Also works standalone with no `$CLAUDE_SESSION_ID` — session-dependent features (session bay, ask-the-author, decisions) degrade gracefully. |
| **P0.3** | **Chapter generation** | Anthropic API (claude-sonnet) groups hunks into 3–7 chapters. Prompt receives the full diff content (chunked into multiple model calls + a merge pass when input exceeds ~150k tokens). Streams via SSE; the browser renders chapters as they arrive. Falls back to file-based grouping if `ANTHROPIC_API_KEY` is unset. |
| **P0.4** | **Per-hunk attribution** | `git blame --follow` (handles file renames/moves) + commit-trailer parsing (`Co-authored-by: claude-sonnet`, prefer trailer over blame author when present, so squashed/rebased history reads correctly). Mixed-author hunks: majority-line-author wins; chip shows the winner. Generated files (`.gitattributes linguist-generated`, lockfiles, `*.snap`, `dist/`) tagged `generated`, excluded from chapter prompts and confidence scoring. Deleted-only hunks blame the prior commit and render with `kind=del` styling. |
| **P0.5** | **Per-hunk confidence (heuristic v1)** | `confidence = file_path_risk × diff_size_factor`. File-path risk is a small lookup table (auth/migrations/billing/secrets → low; tests/docs/fixtures → high; default → medium). No test-coverage signal in v1 — running the suite is too slow for the 15s budget. UI renders as a low/medium/high word with a colour band (red / amber / green). |
| **P0.6** | **Concept 01 view** | Browser renders the imported demo HTML, data-driven from `/api/pr/:id`. Title, chapter sidebar, marker headings, file-pill spans, hunks with attribution chips and confidence bands. Skeleton renders before chapters stream in. |
| **P0.7** | **GitHub link out** | If `gh pr view --json url` returns a URL, display "View on GitHub" in the header. Otherwise show the branch name. |
| **P0.8** | **Local persistence** | Comments and approvals stored in SQLite. Survive restarts and re-publishes (via content-hash hunk identity). Comments are markdown-bodied, no threading, no resolution state, no line anchoring. |
| **P0.9** | **Re-publish updates in place** | Running `reviewdev publish` on the same (repo, branch) updates the existing PR record. Locked chapters (any chapter the user has touched — title/summary edit, hunk move) are preserved. Unlocked chapters and new hunks regenerate. Comments reattach to hunks by content hash. |

### P1 — Nice to have
| # | Requirement | Notes |
|---|---|---|
| **P1.1** | **Session bay** *(Concept 04)* | Right rail lists sessions correlated to this branch. Correlation uses `cwd` recorded in transcript JSONL entries plus the time of recent commits on the branch. Kind labels (Execute / Review / Ship) read from session metadata. Only the `$CLAUDE_SESSION_ID` plus its sub-agent/Task sessions are followed in v1 — broader scans across `~/.claude/projects/` come later if needed. Compacted/cleared sessions show but with a "compacted" badge; decisions extraction skipped for them. |
| **P1.2** | **Resume from review.dev** | "Resume" button on a session generates a `claude --resume <session-id>` command and copies to clipboard. |
| **P1.3** | **Recompose chapters** | Per-chapter button regenerates that chapter's grouping with a new prompt; chapter becomes locked once committed. |
| **P1.4** | **Ask the author** | Per-chapter chat input. Request body = the chapter's hunks + chapter summary + the question + a *relevant slice* of the session transcript (filtered to tool calls and messages that touched files in this chapter). Streams response via SSE. Stored as comments scoped to the chapter so the conversation persists. |
| **P1.5** | **Decisions list** | Right rail in chapter view shows chronological decisions extracted from the session transcript by a single LLM pass at publish time. Adds 5–10s to publish; runs in parallel with chapter generation so it doesn't extend wall time. Skipped for compacted sessions. |
| **P1.6** | **Branches** | Parallel exploratory branches associated with the same root issue, surfaced as in Concept 04. Schema reuses `sessions.kind` — `exploratory` is added as a value. |

### P2 — Phase 2 and beyond
| # | Requirement | Notes |
|---|---|---|
| **P2.1** | `reviewdev/action@v1` | GitHub Action runs the same pipeline on PR open/update. Posts a comment on the PR linking to the hosted review. |
| **P2.2** | **Hosted review.dev** | Same UI, deployed somewhere (OQ.5). Auth via GitHub OAuth. Multi-user. |
| **P2.3** | **Lanes** *(Concept 02)* | Real multi-agent attribution from agent platforms emitting session metadata. |
| **P2.4** | **Behavioral diff** *(Concept 05)* | Run before/after through ephemeral compute, replay user flows. |
| **P2.5** | **Audience switching** *(Concept 03)* | LLM-summarised views of the same PR for PM, Support, Exec. |
| **P2.6** | **Full replay scrubber** *(Concept 06)* | Drag a handle across the agent's session, drop in at any moment. |
| **P2.7** | **Fuzzy hunk migration** | If content-hash orphaning bites during dogfooding, upgrade to context-similarity matching. |
| **P2.8** | **Export comments to GitHub** | One-shot push of comments to the GitHub PR. Deliberately out of MVP. |

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

`reviewdev publish` reads `$CLAUDE_SESSION_ID` (when present) to locate the transcript at `~/.claude/projects/<slug>/<session-id>.jsonl`. The transcript provides:

- **Tool calls** — file edits, bash commands, search results.
- **User messages** — the original goal, mid-session corrections.
- **Agent reasoning** — internal decisions to log on the timeline.
- **`cwd`** — for session↔branch correlation in the session bay.

Sub-agent / Task tool sessions are followed via parent references in the JSONL. For other agents (cursor-tab, codex, gemini), v1 identifies them via commit trailers and shows them as authors. Richer per-step attribution is Phase 2.

### Optional second skill: `/resume-review`
Reverses the flow. From the review surface, "Resume from step 3" copies a `claude --resume` command. From Claude Code, `/resume-review` reads the most recent open PR in `~/.reviewdev/db.sqlite` and continues the corresponding session.

---

## API key

`ANTHROPIC_API_KEY` environment variable only. If unset:

- Chapter generation falls back to file-based grouping (group by top-level directory, secondary split by extension).
- Decisions extraction is skipped.
- Ask-the-author is disabled with a tooltip pointing at setup.
- `reviewdev publish` prints a one-liner: `ANTHROPIC_API_KEY not set — using file-based chapters. See README for setup.`

---

## Success Metrics

**Leading (per-PR usage):**
- Time-to-URL **under 2 seconds (p95)** on a 50-hunk PR.
- Time-to-readable-chapters **under 15 seconds (p95)** on a 50-hunk PR.
- **3–7 chapters** generated per PR (signal of right-sized grouping).
- Per-hunk confidence shows **variance, not flat high** (validates the model is doing work).

**Lagging (over weeks of personal use):**
- **% of my own PRs read in review.dev before merge:** target 80%+ within 2 weeks of week-4 ship.
- **Time-to-merge on agent-authored PRs:** measure baseline first week, target 30% reduction by week 4.
- **Number of "wait, what does this PR even do?" moments:** target zero.

If leading hits and lagging doesn't move, the product is wrong. If lagging moves but leading doesn't, the build is wrong.

---

## Open Questions
| # | Question | Owner |
|---|---|---|
| OQ.5 | Phase 2 deployment target: Fly, Render, Vercel? | Defer until Phase 1 has earned its place |
| OQ.6 | Marking a session as "exploratory" vs "main" — adding the value to `sessions.kind` covers schema, but UX for the user-facing distinction is unspecified. | Engineering — week 1 if P1.6 is built |

All other OQs from Draft 1 are now resolved in the spec body.

---

## Timeline & Phasing
**Week 1 — bootstrap.** `reviewdev serve` (Hono on Bun) + SQLite schema with numbered migrations + `reviewdev publish` writing real diffs with file-based chapters. Demo HTML imported and wired to `/api/pr/:id`. Loop verified end-to-end. No LLM yet.

**Week 2 — chapter generation + dogfood.** Wire Anthropic API with streaming. Generate chapters from the full diff. Per-hunk attribution via `git blame --follow` + trailer parsing. Confidence heuristic. **First real dogfood: reviewdev's own PRs go through reviewdev starting now.** Bugs found dogfooding feed back into week 3.

**Week 3 — skill + session bay.** Skill triggers the CLI; postinstall lays it down. Transcript reading + sub-agent following. Session bay with `cwd`-based correlation. Compacted-session handling. MVP shippable.

**Week 4 — sharpen.** Recompose, ask-the-author with transcript slicing, decisions extraction. README and `bun install -g reviewdev`. Public GitHub repo.

**Pause and use it for a month.** No new features. Every personal PR goes through review.dev. Track success metrics. Note what breaks, what's missing, what's noise.

**Phase 2 — GitHub Action.** Once Phase 1 has earned its place, package the same pipeline as a GitHub Action. Hosted instance for cross-machine review. Open to design partners only after the local version is undeniably useful.

---

## Stack
- **Server:** Bun + Hono. Single binary, fast cold start.
- **DB:** SQLite via `bun:sqlite`. Numbered SQL migrations in `migrations/`, applied on `reviewdev serve` start.
- **Frontend:** Imported `review-dev-demo.html`, parameterised to fetch from `/api/pr/:id`. Streaming via EventSource/SSE. Vanilla JS until a build step earns its keep.
- **LLM:** Anthropic API direct, streaming for chapter generation, decisions, and ask-the-author. Chunking + merge pass for diffs > ~150k tokens.
- **Distribution:** `bun install -g reviewdev`. Postinstall lays down the skill (non-destructive).
- **Telemetry:** None.

## What I'd cut to ship faster
If week 1–3 slips, drop in this order:
1. **Confidence scoring.** Default everything to high; humans look at file path anyway.
2. **Decisions list / session bay.** P1, not P0.
3. **Recompose.** Just re-publish to regenerate.
4. **Multi-agent attribution.** "Everyone not me" is "human" for v1.
5. **Ask the author.** Most expensive P1 to build; cleanest cut if week 4 slips.

Even with all of those cut, the loop is: write code in Claude Code → `/publish-review` → browser pops → read story-shaped PR → approve or comment. That's the MVP.

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

The action runs the same pipeline as the CLI. Difference: it pushes to a hosted instance and posts a comment on the PR linking to the rendered review. The CLI's local mode still works; the action is additive.

---

## Open follow-ups
After this spec lands:
- **Engineering ticket breakdown** — slice P0 into ~12 implementation tickets I can work through in Claude Code (recursive).
- **Skill content** — write the actual `SKILL.md` for `/publish-review` and test it end-to-end.
- **Demo HTML import** — pull the existing Concept 01 HTML into this repo at `web/index.html` before week 1.
- **Stakeholder pitch** — if Phase 2 becomes a real product, a one-pager for design partners.
