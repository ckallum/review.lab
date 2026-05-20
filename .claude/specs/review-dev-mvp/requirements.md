# review.dev MVP — Requirements

Ported from [SPEC.md](../../../SPEC.md) Draft 4. Sister files: [design.md](design.md), [tasks.md](tasks.md), [diagrams.md](diagrams.md).

## Problem
The author writes most code with Claude Code. The PRs that come out are large, well-structured, and unreadable on GitHub — a flat diff with no provenance. The story of why each section exists, which agent wrote what, and how confident the agent was, vanishes the moment the diff renders. Reading your own PRs as if you didn't write them is the friction this product attacks.

## User Stories

- As the author, I want to publish my current branch from inside Claude Code with `/publish-review`, so that a browser tab opens onto a story-shaped view of my own PR before I land it.
- As the author, I want every hunk tagged with which agent wrote it (Claude, cursor-tab, human), so that I can scan provenance without context-switching.
- As the author, I want each `reviewdev publish` to create an immutable revision with its own chapters and comments, so that re-publishing after new commits doesn't silently mutate or lose what I already wrote.
- As the author, I want a "diff vs prior revision" view, so that I can see what changed since I last reviewed without re-reading the whole PR.
- As the author, I want to leave markdown comments on hunks/chapters and approve chapters, so that I can record judgments locally without leaving the terminal.
- As the author, I want a session bay listing every Claude Code session that touched this branch and a one-click "Resume" command, so that I can return to mid-work without thinking.
- As the author, I want to ask the agent a chapter-scoped question and get a streamed answer that uses the original session transcript, so that intent questions get answered without re-reading the diff myself.

## Functional Requirements

### P0 — MVP

1. **FR-P0.1 — Claude Code skill.** `/publish-review` shells `reviewdev publish --cwd $(pwd) --session $CLAUDE_SESSION_ID`. `bun install -g reviewdev`'s postinstall lays down `~/.claude/skills/review-dev/SKILL.md`, refusing to overwrite an existing file and printing the manual override command.
2. **FR-P0.2 — CLI publish.** `reviewdev publish` resolves the diff (fetch + merge-base + auto-detect base), uploads hunks and sessions to the per-repo server, and creates a new revision (or returns the existing URL if `diff_hash` matches latest). URL returned within 2s; chapter render completes within the measured SLA. Standalone mode works without `$CLAUDE_SESSION_ID`.
3. **FR-P0.3 — Chapter generation + decisions.** Single Anthropic API call (`claude-sonnet-4-7`, overridable via `REVIEWDEV_MODEL`) emits `{chapters: [3-7], decisions: [...]}`. Prompt includes the full diff, the prior revision's chapter titles, and which of its hunks survived by content hash, with instructions to reuse where unchanged. Streams via SSE. Falls back to file-based grouping (no decisions) when `ANTHROPIC_API_KEY` is unset.
4. **FR-P0.4 — Per-hunk attribution.** `git blame --follow` + commit-trailer parsing (`Co-authored-by`). Trailer beats blame author. Mixed-author hunks → majority-line winner. Generated files (linguist-generated, lockfiles, `*.snap`, `dist/`) tagged `generated` and excluded from chapter prompts. Deleted-only hunks blame the prior commit, render with `kind=del`.
5. **FR-P0.5 — Confidence display stub.** All hunks render at `confidence=high` in week 1. UI bands are low/medium/high with red/amber/green. `chapters.confidence` column exists in schema so swapping values later is one line.
6. **FR-P0.6 — Concept 01 view.** Browser renders the imported demo HTML (Concept 01 only, extracted from the reference file at `~/Documents/Claude/Projects/review.dev/review-dev-demo.html`), data-driven from `/api/pr/:id/rev/:n`. Numeric `conf 0.94` swapped for word bands. Concepts 02–06 stripped during import.
7. **FR-P0.7 — GitHub link out.** If `gh pr view --json url` succeeds, header shows "View on GitHub." If `gh` is missing/unauthed, stderr is swallowed and the branch name is shown instead.
8. **FR-P0.8 — Comments and approvals.** Stored on the revision they were left on. Markdown body, no threading, no resolution, no line-anchoring. The latest-revision header shows a pill "N comments on earlier revisions · view" that opens a revision picker.
9. **FR-P0.9 — Revision diff view.** `GET /pr/:id/rev/:n/diff` renders code delta (hunks added/removed/unchanged by content-hash) and chapter delta (added/dropped/inherited/regenerated) between revisions `n` and `n-1`. For `n=1`, falls back to the same view as `/pr/:id/rev/1` with no badges.
10. **FR-P0.10 — Navigation API.** `GET /pulls` lists open PRs in the repo (status, branch, title, updated_at, latest_revision_number). `GET /api/pr/:id/revisions` lists revisions in order.

### P1 — Nice to have

11. **FR-P1.1 — Session bay.** Right rail lists sessions correlated to this branch via `cwd` in transcript JSONL + commit timestamps. Kind labels from session metadata. Follows `$CLAUDE_SESSION_ID` + its sub-agent/Task sessions. Compacted sessions show with a "compacted" badge.
12. **FR-P1.2 — Resume from review.dev.** "Resume" button copies `claude --resume <session-id>` to clipboard.
13. **FR-P1.3 — Ask the author.** Per-chapter chat input. Request = chapter hunks + summary + question + a relevant transcript slice (filtered to tool calls and messages touching files in this chapter). Streams via SSE. Stored as comments scoped to the chapter and revision.
14. **FR-P1.4 — Decisions list rendering.** Right rail in chapter view shows chronological decisions from the `decisions` table (already emitted by FR-P0.3's combined LLM call).
15. **FR-P1.5 — Branches.** Parallel exploratory branches surfaced as in Concept 04. Schema reuses `sessions.kind`; `exploratory` is a value.
16. **FR-P1.6 — Diff between arbitrary revision pairs.** UI affordance to diff any two revisions. Cheap once FR-P0.9 ships.
17. **FR-P1.7 — Confidence heuristic.** Only built if dogfood (week 2) reveals the gap. `confidence = file_path_risk × diff_size_factor`.

### P2 — Phase 2 and beyond
GitHub Action (`reviewdev/action@v1`), hosted review.dev, lanes (Concept 02), behavioral diff (Concept 05), audience switching (Concept 03), replay scrubber (Concept 06), comment export to GitHub, cross-repo dashboard. All deferred.

## Non-Functional Requirements

1. **NFR-1 — Time-to-URL.** Under 2 seconds (p95) on a 50-hunk PR.
2. **NFR-2 — Time-to-readable.** Measured in week 1 via the SLA spike. Target band 15–25 seconds (p95) on a 50-hunk PR. The committed number replaces this band before week 2 ships.
3. **NFR-3 — Daily LLM cost.** Under $5/day (p95) during dogfood week. Soft warning at $5; hard cap via `REVIEWDEV_DAILY_CAP`.
4. **NFR-4 — Single-user, local-first.** No accounts, no auth, no telemetry. Localhost only.
5. **NFR-5 — Zero install friction.** `bun install -g reviewdev` is the only setup step. Skill installs itself.
6. **NFR-6 — Tests for silently-corruptible surfaces.** Hash + revision-diff and chunked-LLM merge suites must pass before week 1 ships. Recorded LLM fixtures, no live API in CI.

## Out of Scope

- Multi-user / hosted / cloud / auth (Phase 2).
- Behavioral diff sandbox (Concept 05).
- Full replay scrubber (Concept 06).
- Audience switching beyond engineer view (Concept 03).
- Real-time collab. No GitHub sync — not even an export button.
- Self-hosted distribution for other people. Public repo, but not packaged.
- Uncommitted changes — must commit before publish.
- Cross-repo dashboard.
- Comment migration across revisions. By design — each revision is immutable, comments live where they were left.
- Diff between arbitrary revision pairs (P1.6 may pick this up).
- Per-hunk LLM confidence rating in MVP.
