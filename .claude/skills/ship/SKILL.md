---
_origin: calsuite@0ce554a
name: ship
version: 1.0.0
description: |
  ship it, push this, create PR, land this, send it, merge this, commit and push,
  open a pull request, ship this branch, clean gone branches, pr only, just make a pr,
  quick pr, docs only pr.
  Fully automated: merge main, test, review, split commits, push, create PR.
  PR-only mode for lightweight changes (docs, config, skills).
argument-hint: [clean | pr]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
---

# Ship: Fully Automated Ship Workflow

You are running the `/ship` workflow. This is a **non-interactive, fully automated** workflow. Do NOT ask for confirmation at any step unless specified. The user said `/ship` which means DO IT.

## Arguments

- `/ship` — full ship workflow (default)
- `/ship pr` — PR-only mode: commit, push, create PR. Skips tests, review, and simplification. For docs, config, skills, and other lightweight changes.
- `/ship clean` — clean up stale local branches marked as `[gone]` on remote, including worktrees

---

## PR-Only Mode

If `$ARGUMENTS` contains "pr":

Fast path — commit, push, and create a PR with a rich body. Skips tests, review, simplification, and CHANGELOG. Designed for docs-only, config, skill, and other low-risk changes.

### Step 1: Pre-flight

1. Check the current branch. If on `main`, **abort**: "You're on main. Ship from a feature branch."
2. Run `git status` (never use `-uall`).
3. Run `git diff origin/main...HEAD --stat` and `git log origin/main..HEAD --oneline` to understand what's being shipped.

### Step 2: Commit

Stage all changes and create a single commit:

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <summary>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

Use `docs:` for documentation, `chore:` for config/skills, `style:` for formatting. If there are already commits on the branch and no uncommitted changes, skip this step.

### Step 2.5: Sweep and fix PR-introduced bugs inline

Even in pr-only mode, scan the conversation for **bugs in code this branch is changing**. PR-only mode skips tests, review, and simplification — but it must NOT skip the rule that bugs introduced by the PR get fixed in the PR.

```bash
git diff origin/main --name-only > /tmp/ship-changed-files.txt
```

Hold the contents as `CHANGED_FILES`. Review the conversation for any minor bugs, TODOs, edge cases, or rough edges that surfaced during the work. For each candidate, check whether it touches `CHANGED_FILES`:

- **If yes and it's a bug:** fix it now, stage, commit (`git commit -m "fix: <what>"`). No exceptions.
- **If yes and it's an enhancement/cleanup:** default to fixing inline unless it would meaningfully grow the PR.
- **If no:** defer to Step 4 (the post-PR `/sweep-issues` call will create the issue).

Skip this step silently if no candidates surfaced.

### Step 3: Push, run Pre-PR Gates, create PR

```bash
git push -u origin $(git branch --show-current)
```

Run the Pre-PR Gates from **Step 7.4** (PR-size, test-presence, spec-contract) before drafting the body. Even in pr-only mode, these gates surface useful warnings — the test-presence gate typically stays silent on docs/config changes because it only warns when `code_additions > 50`. Spec-contract still applies if the repo has active specs.

Read the PR body template at `.claude/skills/ship/pr-template.md`. Draft the PR body following the template structure, but omit Test Results and Pre-Landing Review sections (not applicable in pr-only mode). Skip diagrams for trivial changes (< 50 lines, single-file edits). If any Pre-PR Gate produced findings, include them below Summary as a `## Pre-PR Gates` section.

Run **Step 8.5** (PR-claim-vs-diff grep) against the drafted body before calling `gh pr create`.

**Output the PR URL.**

### Step 4: Sweep for Deferred Issues

Invoke `/sweep-issues` using the Skill tool:

```text
skill: "sweep-issues"
args: ""
```

Same as full ship mode — scans the conversation for deferred items and auto-creates GitHub issues.

---

## Clean Mode

If `$ARGUMENTS` contains "clean":

1. Run `git fetch --prune` to update remote tracking info.
2. List branches marked as gone: `git branch -vv | grep ': gone]'`
3. For each gone branch:
   - Check if it has an associated worktree: `git worktree list`
   - If worktree exists, remove it: `git worktree remove <path> --force`
   - Delete the branch: `git branch -D <branch>`
4. Report what was cleaned up, then **STOP**.

---

## Ship Mode (default)

**Only stop for:**
- On `main` branch (abort)
- Merge conflicts that can't be auto-resolved (stop, show conflicts)
- Test failures (stop, show failures)
- Pre-landing review finds CRITICAL issues and user chooses to fix
- Anything that would lose work

**Never stop for:**
- Uncommitted changes (always include them)
- CHANGELOG content (auto-generate from diff)
- Commit message approval (auto-commit)

---

## Step 1: Pre-flight

1. Check the current branch. If on `main`, **abort**: "You're on main. Ship from a feature branch."

2. Run `git status` (never use `-uall`). Uncommitted changes are always included.

3. Run `git diff origin/main...HEAD --stat` and `git log origin/main..HEAD --oneline` to understand what's being shipped.

---

## Step 2: Merge origin/main (BEFORE tests)

Fetch and merge `origin/main` into the feature branch so tests run against the merged state:

```bash
git fetch origin main && git merge origin/main --no-edit
```

**If merge conflicts:** Try to auto-resolve simple ones (CHANGELOG ordering, lock files). If complex, **STOP** and show them.

**If already up to date:** Continue silently.

---

## Step 3: Run tests (on merged code) — PARALLEL AGENTS

Check `git diff origin/main --name-only` to determine which areas changed. Read CLAUDE.md and package.json to discover the project's test commands.

Dispatch **parallel sub-agents** for each applicable test suite using the Agent tool. Launch all agents in a **single message** (multiple Agent tool calls). Each agent should run the appropriate test command for the changed area and report pass/fail count and any failures.

Example agent prompts (adapt to the project's actual test commands):
```
prompt: "Run the test suite: <test-command>. Report pass/fail count and any failures."
description: "<area> tests"
```

Wait for all test agents to complete. Collect results.

**If any test fails:** Show the failures and **STOP**. Do not proceed.

**If all pass:** Continue — just note the counts briefly.

---

## Step 4: Simplify Changed Code

After tests pass, dispatch a **code simplification agent**:

```text
prompt: "Review all files changed between origin/main and HEAD (run `git diff origin/main --name-only` to find them). For each changed file, check for: code that could be reused from existing utilities, unnecessarily complex logic that could be simplified, redundant code, inconsistent patterns vs the rest of the codebase. Read CLAUDE.md conventions section first. Output a list of specific simplification suggestions with file:line references. If a suggestion is safe and obvious, apply the fix directly using Edit. Only apply fixes that preserve exact functionality."
description: "Simplify changed code"
```

If the agent made edits, stage them. If it only suggested changes, apply the safe ones.

**Important:** Simplification runs BEFORE the review so the review stamp covers the final code state.

---

## Step 4.5: Pre-Landing Review

After simplification is complete, invoke `/review` using the Skill tool:

```text
skill: "review"
args: "greptile"  ← include if the project uses Greptile
```

This dispatches the full `/review` workflow: parallel @code-reviewer + checklist agents, Greptile triage, TODO cross-reference, and review stamp.

**If `/review` reports BLOCKED:** The skill will have already asked the user about each critical finding via AskUserQuestion. If the user chose "Fix it now" on any issue, apply the fixes, commit them (`git add <fixed-files> && git commit -m "fix: apply pre-landing review fixes"`), then **re-run from Step 3** to verify fixes don't break tests.

**If `/review` reports PASS:** Continue. Include any informational findings in the PR body.

---

## Step 5: CHANGELOG (auto-generate)

1. Read `CHANGELOG.md` header to know the format. If no CHANGELOG.md exists, skip this step.

2. Auto-generate entries from **ALL commits on the branch**:
   - Use `git log origin/main..HEAD --oneline` for every commit being shipped
   - Use `git diff origin/main...HEAD` for the full diff
   - Categorize into: `### Added`, `### Changed`, `### Fixed`
   - Write concise, descriptive bullet points
   - Insert under `## [Unreleased]` section
   - Follow Keep a Changelog format

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.

---

## Step 6: Commit (bisectable chunks)

**Goal:** Create small, logical commits that work well with `git bisect`.

1. Analyze the diff and group changes into logical commits. Each commit = one coherent change.

2. **Commit ordering** (earlier first):
   - **Schema/migrations:** new DB tables, schema changes
   - **Backend:** new config, services, background jobs (with their tests)
   - **API routes:** new/modified routes (with their tests)
   - **Frontend:** components, pages (with their tests)
   - **CHANGELOG:** always in the final commit

3. **Rules for splitting:**
   - A component and its test file go in the same commit
   - An API route and its test go in the same commit
   - Migrations are their own commit (or grouped with the schema they support)
   - If the total diff is small (< 50 lines across < 4 files), a single commit is fine

4. **Each commit must be independently valid** — no broken imports.

5. Commit messages: `<type>: <summary>` (type = feat/fix/chore/refactor/docs)
   Only the **final commit** gets the co-author trailer:

```bash
git commit -m "$(cat <<'EOF'
chore: update changelog

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Step 7: Push

Push to the remote with upstream tracking:

```bash
git push -u origin $(git branch --show-current)
```

---

## Step 7.2: Sweep and Fix Inline

**Before** running Pre-PR Gates, scan the conversation for deferred items, fast-follows, minor bugs, enhancements, and tech debt — the same categories `/sweep-issues` looks for. Fix anything coherent with the current PR; defer the rest to Step 9.

### 7.2a: Gather candidates and capture the diff file list

First, capture the canonical list of files this branch touches — every later triage decision is grounded against it:

```bash
git diff origin/main --name-only > /tmp/ship-changed-files.txt
```

Hold the contents as `CHANGED_FILES`. Then review the conversation for deferred work, TODOs, edge cases, minor bugs, and improvements. For each item, note a one-line description, its source (conversation turn, review finding, etc.), and **the file(s) it relates to** if known.

### 7.2b: Triage — fix now vs. create issue

For each candidate, first check whether it touches `CHANGED_FILES`. **If it does, default to "fix now"** — the reviewer is going to see those files anyway, and any bug, TODO, or rough edge in them belongs in the same PR. Only override the default if the user explicitly confirms the issue is pre-existing and out of scope.

Classify each candidate:

| Fix now (inline) | Create issue (later) |
|---|---|
| **Anything touching a file in `CHANGED_FILES`** (default) | Feature request unrelated to this PR |
| Minor bug in code touched by this PR | Large refactor spanning multiple files not in this diff |
| Missing edge case in a function this PR added/modified | Work that requires design discussion |
| TODO/FIXME left in files changed by this PR | Performance optimization with unclear scope |
| Small enhancement coherent with the PR's purpose | Anything that would change the PR's scope significantly |
| Cleanup in files already being modified | Pre-existing bug in a file this PR doesn't touch |

**The test:** "Would a reviewer expect this to be part of this PR?" If the candidate's file is in `CHANGED_FILES`, the answer is almost always yes — fix now. If no → create issue.

**Bugs introduced by this PR are never deferrable.** If a candidate is a bug AND its file is in `CHANGED_FILES`, fix it inline. Do not move it to the "create issue" column even if the user requested deferring something else.

### 7.2c: Apply inline fixes

For each "fix now" item:
1. Make the fix
2. Stage it: `git add <files>`
3. Commit: `git commit -m "fix: <what was fixed>"`

### 7.2d: Re-run tests if fixes were applied

If any inline fixes were made, re-run the test suites from Step 3 to verify no regressions. If tests fail, fix the failure before proceeding.

### 7.2e: Push inline fixes

If new commits were created:
```bash
git push
```

### 7.2f: Hand off deferred items

Record the "create issue" candidates from 7.2b as `DEFERRED_ITEMS` — Step 9 will turn them into GitHub issues. Do not create the issues now (the PR should be open first, so issues can cross-link it).

---

## Step 7.4: Pre-PR Gates

Before drafting the PR body, run three cheap grep/glob-based gates against the diff, then collect their output. These gates **warn but do not block** by default — surface context so the user can either proceed with intent or pause to address. Each gate runs independently; collect all outputs and show them together before Step 8.

### Gate 1 — PR-size warning

```bash
added=$(git diff origin/main --shortstat | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
if [ "${added:-0}" -gt 400 ]; then
  # Identify the top files dominating the diff
  git diff origin/main --numstat | awk '{print $1 + $2, $3}' | sort -rn | head -5
fi
```

If `added > 400`, emit:
```text
⚠ PR size: <N> lines added. Large PRs get surface-level reviews.
  Top files:
    <N1> lines  <path1>
    <N2> lines  <path2>
  Suggest: split on commit boundaries —
    git log origin/main..HEAD --oneline
  Each commit is already a logical split point. Consider shipping one per PR.
```
Do NOT block. The user decides.

### Gate 2 — Test-presence gate

**Universal heuristic (always runs):**
```bash
# Count new test functions across all languages in the diff
diff=$(git diff origin/main)
new_tests=$(echo "$diff" | grep -cE '^\+\s*(#\[(test|tokio::test|rstest)\]|\btest\(|\bit\(|def\s+test_|func\s+Test[A-Z]|it\s+[\x27"])' || true)

# Count substantive code additions in non-test, non-docs, non-config files
code_additions=$(git diff origin/main -- \
  ':(exclude)**/*.test.*' \
  ':(exclude)**/*.spec.*' \
  ':(exclude)**/tests/**' \
  ':(exclude)**/__tests__/**' \
  ':(exclude)**/migrations/**' \
  ':(exclude)docs/' \
  ':(exclude).github/' \
  ':(exclude)*.md' \
  ':(exclude)*.json' \
  | grep -cE '^\+[^+]' || true)
```

If `code_additions > 50` AND `new_tests == 0`, emit:
```text
⚠ Test-presence: <N> lines of code added, zero new tests.
  Code-only files (no tests alongside):
    <list of non-test files with net-positive additions>
  If this is intentional (refactor, config, docs), proceed. Otherwise consider
  adding tests before shipping.
```

**Optional strict mode (per-repo):**
```bash
# Check for .claude/ship-config.json at the repo root
if [ -f .claude/ship-config.json ]; then
  critical_globs=$(node -e '
    try {
      const c = require(process.cwd() + "/.claude/ship-config.json");
      if (Array.isArray(c.criticalPaths)) console.log(c.criticalPaths.join("\n"));
    } catch {}
  ')
  strict=$(node -e '
    try { console.log(!!require(process.cwd() + "/.claude/ship-config.json").strict); }
    catch { console.log("false"); }
  ')
fi
```

For each critical glob, check whether any diff file matches it (use the same glob-matching logic as `lint-gate.cjs`). If a critical path is touched AND `new_tests == 0`, emit a strong warning that cites the matching glob:

```text
⚠ Test-presence (STRICT): critical path touched without tests.
  Matched glob: <glob pattern>
  Files: <matching files from diff>
  No new tests detected in this PR.
```

If `strict: true` in ship-config.json, this blocks. Otherwise surface and continue.

### Gate 3 — Spec-contract deviation

Detect the active spec the same way `/review` Agent I does:
```bash
branch=$(git branch --show-current)
slug=$(echo "$branch" | sed -E 's#^(feat|fix|chore|refactor|feature)/##')
SPEC_DIR=""
[ -d ".claude/specs/$slug" ] && SPEC_DIR=".claude/specs/$slug"
[ -z "$SPEC_DIR" ] && SPEC_DIR=$(find .claude/specs -mindepth 1 -maxdepth 2 -name design.md -exec dirname {} \; 2>/dev/null | head -1)
```

If `$SPEC_DIR` is non-empty:
1. Read `$SPEC_DIR/design.md` and `$SPEC_DIR/tasks.md`.
2. For each named symbol/field/event/task in these files, grep the diff.
3. For each unchecked task in `tasks.md`, check whether the diff plausibly addresses it.

Flag two classes:
  - **MISSING:** spec promises a specific symbol/event/task, diff does not contain it.
  - **EXTRA:** diff introduces behavior (new command handler, new event emitter, new persisted field) not described anywhere in `design.md`.

For each deviation, use AskUserQuestion individually:
```text
<Deviation description — what the spec says vs what the diff does>

Recommendation: [A or B, lead with your pick and 1-sentence reason]

A) Remediate: bring the diff back to the spec before shipping.
B) Update spec: mark the outdated bullet in design.md/tasks.md with strikethrough
   (~~old text~~) and append an **Addendum** under the same section describing
   the current implementation path. Then ship.
C) Dismiss: not a real deviation.
```

If the user picks B, apply the edit to `design.md` and/or `tasks.md` using the following pattern — preserve the original bullet (struck through) and add a dated addendum directly beneath it:

```markdown
- ~~Original task/bullet text~~
  - **Addendum (YYYY-MM-DD):** <current implementation path — what was built
    instead, and why (1-2 sentences)>.
```

Stage the spec edit alongside the PR commits. Skip this gate silently if `$SPEC_DIR` is empty.

### Output collection

Collect the output of Gates 1-3 as `PRE_PR_GATE_FINDINGS`. These will be surfaced in the PR body (below the Summary section, above How It Works) and in the user-facing console output before Step 8. If every gate passes cleanly, `PRE_PR_GATE_FINDINGS` is empty and nothing is added to the PR body.

---

## Step 7.5: Generate Development Flow diagram

Before creating the PR, check if a flow trace file exists for this session and is non-empty. Use the `:-unknown` fallback so the path still resolves when `CLAUDE_SESSION_ID` is unset (matching the convention used by calsuite's other session-scoped trackers, e.g. `skill-usage-tracker.cjs`):

```bash
session_id="${CLAUDE_SESSION_ID:-unknown}"
test -s ".claude/flow-trace-${session_id}.jsonl"
```

If the file exists and is non-empty, read and parse the JSONL entries and generate a Mermaid `flowchart TD` diagram following the same rules as the `/flow` skill:
- Skill nodes: `S1(skill-name)`, Agent nodes: `A1{{agent-type: description}}`
- Sequential entries get `-->` edges
- Parallel detection: entries within 1s of each other from same predecessor = fan-out
- Collapse N identical consecutive dispatches into one node with `xN` label

This diagram will be inserted as a `## Development Flow` section in the PR body (see below).

If the trace file is missing or empty, skip the `## Development Flow` section entirely — no error, no placeholder.

---

## Step 8: Draft PR body

Read the PR body template at `.claude/skills/ship/pr-template.md` and follow its structure exactly.

Populate each section:
- **Summary** — bullet points from CHANGELOG entries (what shipped)
- **Pre-PR Gates** — findings from Step 7.4 (omit section entirely if no findings)
- **How It Works** — Mermaid diagram for non-trivial PRs (skip for < 50 lines, config-only, docs-only)
- **Development Flow** — Mermaid diagram from flow trace (insert after How It Works, before Important Files). Only include if trace data exists.
- **Important Files** — table of key files with one-line descriptions
- **Test Results** — table from Step 3
- **Pre-Landing Review** — findings from Step 4.5, or "No issues found."
- **Doc Completeness** — checklist

Hold the drafted body as `PR_BODY_DRAFT` — do NOT call `gh pr create` yet. Step 8.5 verifies the body against the diff.

---

## Step 8.5: PR-claim-vs-diff grep

Before creating the PR, cross-check the drafted body against the actual diff. The goal is to catch "promised-but-not-delivered" claims — PR bodies that mention symbols, fields, or events that never appear in the changes.

1. Extract claims from `PR_BODY_DRAFT`. A claim is any identifier wrapped in backticks that names code:
   - Type/struct names (e.g. `` `SessionDetail` ``)
   - Field/key names (e.g. `` `hydrated_from_storage` ``)
   - Event names (e.g. `` `session-hydrate-degraded` ``)
   - Function/method names (e.g. `` `open_session()` ``)
   - Constants (e.g. `` `MAX_RETRY_COUNT` ``)

   Skip claims that are obviously not symbols: English prose in backticks, file paths, shell commands, or package names.

2. For each extracted claim, grep the diff:
   ```bash
   git diff origin/main | grep -F "<claim>" >/dev/null || echo "MISSING: <claim>"
   ```

3. If any claims are missing from the diff, surface them above the PR body draft:
   ```text
   ⚠ PR body claims not found in diff:
     - `hydrated_from_storage`  — mentioned in Summary, not in any changed file
     - `session-hydrate-degraded` — mentioned in How It Works, not emitted anywhere

   Options:
     A) Edit PR body to remove the claim(s)
     B) Edit the code to actually deliver the claim(s)
     C) Dismiss — the claim is correct, grep missed it (explain why)
   ```

   Use AskUserQuestion for each missing claim individually.

4. If no claims are missing, proceed silently.

---

## Step 8.6: Create PR

Create the PR using `gh pr create` with `PR_BODY_DRAFT` passed via HEREDOC. **Output the PR URL.**

---

## Step 9: Create Issues for Deferred Items

After the PR is created, turn the `DEFERRED_ITEMS` list from Step 7.2b into GitHub issues. The triage already happened — `/sweep-issues` only needs to create the issues.

```text
skill: "sweep-issues"
args: ""
```

`/sweep-issues` re-scans the conversation as a safety net in case new items emerged after Step 7.2 (e.g. from Step 4.5 review or the claim-grep in 8.5). It deduplicates against the `DEFERRED_ITEMS` list and against existing GitHub issues.

**If nothing remains to defer:** Continue silently — the PR URL is the final output.
**If items found:** Create the issues and output the sweep summary. The PR URL remains the last line of output.

---

## Gotchas

- **Use `origin/main` not local `main`.** Local main may be stale. All diff/merge commands use `origin/main`.
- **Review gate may block fix commits.** If you commit review fixes and the review gate blocks, re-run from Step 3 for a fresh stamp.
- **Simplify runs BEFORE review** so the review stamp covers the final code state. Don't reorder Steps 4 and 4.5.
- **`git push` may fail if the branch was force-pushed elsewhere.** Never force push to recover — ask the user.
- **CHANGELOG auto-generation reads all commits on the branch** — if prior commits have bad messages, the CHANGELOG entries will be vague.
- **`/ship pr` skips the heavy safety checks** (full test suite, simplification, Pre-Landing Review, CHANGELOG generation, commit splitting) but still runs the cheap ones: the Step 2.5 PR-introduced-bug sweep, the Pre-PR Gates from Step 7.4 (PR-size, test-presence, spec-contract), and the PR-claim-vs-diff grep (Step 8.5). Use for genuinely low-risk changes (docs, config, skills); if in doubt, use `/ship`.
- **Pre-PR Gates (Step 7.4) warn but do not block** unless `.claude/ship-config.json` sets `strict: true`. They surface context about the diff shape — large PRs, no-test diffs, spec deviations — but the user always has the final word.
- **`.claude/ship-config.json` is optional and per-repo.** Keys: `criticalPaths: [glob, ...]` for strict test-presence on sensitive files, `strict: true` to promote the strict warning into a block. Only the test-presence gate reads this file — size, spec-contract, and claim-grep gates run unconditionally.
- **PR-claim-vs-diff grep (Step 8.5) uses literal string search.** A claim is missing if `grep -F` doesn't find it in the full diff. If the code renamed a symbol that the PR body still references, the grep correctly flags it.
- **Spec-contract deviation (Gate 3) mutates `design.md`/`tasks.md`** when the user picks option B (strikethrough + addendum). Those edits get staged with the shipping commits — review them before pushing.

## Important Rules

- **Never skip tests.** If tests fail, stop.
- **Never skip the pre-landing review.** Run it every time.
- **Never force push.** Use regular `git push` only.
- **Never ask for confirmation** except for CRITICAL review findings.
- **Split commits for bisectability** — each commit = one logical change.
- **The goal is: user says `/ship`, next thing they see is the review + PR URL.**
