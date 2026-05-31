---
_origin: calsuite@dfaf5b4
name: review
version: 1.1.0
description: |
  review this, pre-landing review, check my code, review before merge, code review,
  look over my changes, audit this PR, review PR, review pull request.
  Up to 9 parallel review agents: conventions, security checklist, git blame history,
  previous PR comments, code comment compliance, silent failure hunting, type design,
  cross-module format consistency, spec-contract deviation.
  Confidence scoring, Greptile triage, TODO cross-reference, flow diagrams.
  Multi-PR mode: /review pr 123,124,125 --multi spawns separate Claude Code instances per PR.
  Adversarial converse mode: /review pr 123 --converse codex runs Claude's review then debates findings with another model CLI.
argument-hint: "[pr <number>[,number,...]] [greptile] [--multi] [--converse cli[:model]]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# Pre-Landing PR Review

You are running the `/review` workflow. Analyze the current branch's diff against main for structural issues that tests don't catch.

## Domain awareness

If the repo has a `CONTEXT.md` (or a `CONTEXT-MAP.md` pointing to per-module `CONTEXT.md` files), read it before dispatching review agents. **Use its vocabulary verbatim** in findings — refer to the "Order intake module" if the glossary names it that, not "the order service." Inconsistent vocabulary in review feedback creates churn during execute/ship.

If `docs/adr/` exists and the diff touches an area covered by an ADR, include "respect ADR-NNNN" in the relevant agent prompts so findings don't propose changes the ADR already rejected.

## Arguments

- `/review` — full review of current branch vs main (default)
- `/review greptile` — include Greptile bot comment triage (auto-detected for repos with prior triage history)
- `/review pr <number>` — review an existing PR by number (fetches diff from GitHub, posts findings as PR comment)
- `/review pr 123 --multi` — spawn a separate Claude Code instance in a new tmux pane (context-free, unbiased)
- `/review pr 123,124,125 --multi` — one new pane per PR
- `/review --converse codex` — adversarial review: Claude reviews, then debates findings with Codex CLI until consensus
- `/review pr 123 --converse codex` — same but for a PR (posts consensus findings as PR comment)
- `/review pr 123 --converse codex:o3` — specify adversary model (format: `cli:model`)

---

## Step 0: Multi Mode

**If `$ARGUMENTS` contains `--multi`:**

`--multi` means "new tmux pane, clean context" — works with one PR or many. Each PR gets its own Claude Code instance for unbiased review.

1. Parse PR numbers from arguments (single number like `123` or comma-separated like `123,124,125`).
2. **Validate each parsed value matches `^[0-9]+$`.** Reject anything else before touching tmux — a value containing `$(...)`, backticks, or other shell metacharacters would fire command substitution inside the double-quoted tmux command in step 4.
   ```bash
   for pr in "${PRS[@]}"; do
     [[ "$pr" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $pr"; exit 1; }
   done
   ```
3. Get the current tmux window: `tmux display-message -p '#S:#I'`
4. For each validated PR number, create a new tmux pane and launch a Claude Code instance:

```bash
# For each validated PR number in the list:
tmux split-window -t "$SESSION:$WINDOW" -h "claude --dangerously-skip-permissions --print 'Run /review pr <NUMBER>. Post your full findings as a PR comment. Do not make any code changes.' 2>&1; echo '--- Review of PR #<NUMBER> complete. Press Enter to close. ---'; read"
tmux select-layout -t "$SESSION:$WINDOW" tiled
```

4. Output:
```text
Multi-PR review launched:
  PRs: #123, #124, #125
  Panes: 3 new tmux panes created
  Mode: context-free — each instance reviews independently

Each instance will post its findings as a comment on the respective PR.
Watch progress in the tmux panes. This instance is done.
```

5. **STOP.** Do not proceed to Step 1 — the tmux instances handle the reviews.

---

## Step 0.5: Converse Mode (Adversarial Review)

**If `$ARGUMENTS` contains `--converse <model>`:**

Both models review independently and in parallel — neither sees the other's findings. Then they exchange results and debate disagreements until consensus. The user sees which issues both found (high confidence), which were unique to each, and what got dropped as false positives.

### Parse the adversary argument

The `--converse` value can be `cli` or `cli:model` (e.g., `codex`, `codex:o3`, `claude:sonnet`).

```bash
# Parse "codex:o3" → CLI="codex", MODEL="o3"
# Parse "codex"    → CLI="codex", MODEL="" (use CLI default)
IFS=':' read -r ADVERSARY_CLI ADVERSARY_MODEL <<< "<converse-value>"
```

### Supported CLIs and model flags

| CLI | Model flag | Default model | Non-interactive invocation |
|-----|-----------|---------------|---------------------------|
| `codex` | `-m <model>` | CLI default | `codex exec [-m <model>] -o "$CONVERSE_TMPDIR/file.txt" -` |
| `gemini` | `-m <model>` | CLI default | `gemini [-m <model>] -p "prompt" > "$CONVERSE_TMPDIR/file.txt"` |
| `claude` | `--model <model>` | CLI default | `claude [--model <model>] --print "prompt" > "$CONVERSE_TMPDIR/file.txt"` |

Validate the CLI is supported and installed:
```bash
# Allowlist check — reject unknown CLIs immediately (prevents arbitrary command injection from $ARGUMENTS)
case "$ADVERSARY_CLI" in
  codex|gemini|claude) ;;
  *) echo "Unsupported CLI: $ADVERSARY_CLI (allowed: codex, gemini, claude)"; exit 1 ;;
esac

# Existence check — stop if not installed
command -v "$ADVERSARY_CLI" >/dev/null 2>&1 || {
  echo "CLI '$ADVERSARY_CLI' not found. Install it first."
  exit 1
}

# Build model flag as an array — prevents glob expansion and preserves spaces in model names.
# A scalar like MODEL_FLAG="-m $ADVERSARY_MODEL" used unquoted would word-split and glob-expand,
# and quoted would collapse "-m foo" into a single argument the CLI rejects.
MODEL_FLAG=()
if [ -n "$ADVERSARY_MODEL" ]; then
  case "$ADVERSARY_CLI" in
    codex)  MODEL_FLAG=(-m "$ADVERSARY_MODEL") ;;
    gemini) MODEL_FLAG=(-m "$ADVERSARY_MODEL") ;;
    claude) MODEL_FLAG=(--model "$ADVERSARY_MODEL") ;;
  esac
fi
```

### CLI dispatch helper

Use the appropriate invocation per CLI. All three execution phases use this pattern:
```bash
# Usage: run_adversary <output-file> [&]
# Reads prompt from stdin, writes response to <output-file>
run_adversary() {
  local outfile="$1"
  case "$ADVERSARY_CLI" in
    codex)  codex exec "${MODEL_FLAG[@]}" -o "$outfile" - ;;
    gemini) gemini "${MODEL_FLAG[@]}" -p "$(cat -)" > "$outfile" ;;
    claude) claude "${MODEL_FLAG[@]}" --print "$(cat -)" > "$outfile" ;;
  esac
}
```

### Converse workflow

**Phase 1: Both models review in parallel**

Kick off BOTH reviews simultaneously — Claude's review and the adversary's review run at the same time.

**1a. Create a unique temp directory and save the diff:**
```bash
CONVERSE_TMPDIR=$(mktemp -d /tmp/converse-XXXXXX)

# PR mode:
gh pr diff <number> > "$CONVERSE_TMPDIR/diff.txt"
# Local mode:
git diff origin/main > "$CONVERSE_TMPDIR/diff.txt"
```

**1b. Launch the adversary review as a background process:**

Start the other model's independent review in the background BEFORE Claude begins its own review. Pipe the diff and a review prompt via stdin. Use **unquoted** heredoc delimiter so `$(cat ...)` expands:

```bash
cat <<PROMPT_EOF | run_adversary "$CONVERSE_TMPDIR/adversary-review.txt" &
You are a code reviewer. Below is a diff. Perform a thorough code review.

For each issue found, output:
- [file:line] SEVERITY (CRITICAL/HIGH/MEDIUM/LOW): description
  Fix: suggested fix

Look for: security issues, race conditions, logic errors, missing error handling,
convention violations, silent failures, type safety issues, missing validation,
resource leaks, and anything that tests wouldn't catch.

DIFF:
$(cat "$CONVERSE_TMPDIR/diff.txt")
PROMPT_EOF
ADVERSARY_PID=$!
```

**1c. Run Claude's review (Steps 1-5 as normal):**

While the adversary runs in the background, proceed with the full Claude review workflow (Steps 1 through 5). Collect all findings into `CLAUDE_FINDINGS`.

**1d. Wait for the adversary to finish:**

```bash
wait $ADVERSARY_PID
```

Read the adversary's independent findings from `$CONVERSE_TMPDIR/adversary-review.txt`. Store as `ADVERSARY_FINDINGS`.

Both reviews are now complete — neither has seen the other's findings.

**Phase 2: Exchange findings and identify disagreements**

Now both models have independent findings. Send BOTH sets to the adversary and ask it to compare:

```bash
cat <<PROMPT_EOF | run_adversary "$CONVERSE_TMPDIR/round-1.txt"
You previously reviewed a diff and found these issues:

YOUR FINDINGS:
$(cat "$CONVERSE_TMPDIR/adversary-review.txt")

Another reviewer (Claude) independently found these issues:

CLAUDE'S FINDINGS:
${CLAUDE_FINDINGS}

Compare both sets of findings. For each item from EITHER reviewer:
- AGREE: <finding summary> — both reviewers found this or you confirm the other's finding
- DISAGREE: <finding from Claude> — <why you think it's wrong>
- UNIQUE_MINE: <your finding Claude missed> — <why it matters>
- UNIQUE_THEIRS: <Claude's finding you missed> — ACCEPT if valid, REJECT with reason if not

Be honest — if Claude caught something you missed, say so. If you found something they missed, explain why it matters.
PROMPT_EOF
```

Claude also independently processes the adversary's findings:
- For each adversary finding that Claude also found: mark as AGREE
- For each adversary finding Claude missed: verify against the actual code, ACCEPT or REJECT
- For each Claude finding the adversary missed: note as UNIQUE_CLAUDE

**Phase 3: Debate disagreements (max 3 rounds)**

Only debate items where the two models DISAGREE. Skip items both agree on.

For each round:

1. Read the adversary's response.
2. For each DISAGREE item: re-examine the code. Either concede (drop the finding) or defend with evidence (cite specific lines).
3. For each REJECT from the adversary on Claude's unique findings: defend with code evidence or concede.
4. Send Claude's responses back to the adversary:

```bash
cat <<PROMPT_EOF | run_adversary "$CONVERSE_TMPDIR/round-N.txt"
Continuing the code review debate. Only respond to unresolved items.

For each item, respond:
- RESOLVED: <finding> — we agree on <outcome: KEEP or DROP>
- STILL_DISAGREE: <finding> — <new evidence or reasoning>

Stop debating items marked RESOLVED.

PREVIOUS EXCHANGE:
${PREVIOUS_ROUNDS}

CLAUDE'S RESPONSE:
${CLAUDE_RESPONSE}
PROMPT_EOF
```

**Exit conditions (stop debating when ANY is true):**
- All items are RESOLVED
- Max 3 rounds reached
- Adversary response repeats previous arguments without new evidence

**Phase 4: Build consensus report**

Compile the final findings from the debate:

```markdown
## Adversarial Review: Claude × <Adversary>

### Both found independently (high confidence)
1. [file:line] Issue description — severity
   Found by both reviewers independently — very likely real.

### Claude only → accepted by adversary
1. [file:line] Issue description — severity

### Adversary only → accepted by Claude
1. [file:line] Issue description — severity

### Dropped by debate (false positives)
1. [file:line] Original finding by <reviewer> — dropped because: <reason>

### Unresolved (no consensus after 3 rounds)
1. [file:line] Finding — Claude says: X, Adversary says: Y

### Review Stats
- Claude found: N issues | Adversary found: M issues
- Both found independently: X | Unique to Claude: Y | Unique to adversary: Z
- Dropped as false positive: W | Unresolved: V
- Debate rounds: R

### Debate Log
<Round 1 — Exchange>
Claude's findings: [summary]
Adversary's findings: [summary]
<Round 2 — Disagreements>
...
```

**Phase 5: Output**

- **PR mode:** Post the consensus report as a PR comment using `gh pr comment`.
- **Local mode:** Print the consensus report to the user.

Clean up temp directory:
```bash
rm -rf "$CONVERSE_TMPDIR"
```

**Then STOP.** Do not proceed to Step 7/8 — the converse report replaces the normal summary.

---

## Step 1: Pre-flight

**If `$ARGUMENTS` contains `pr <number>`:** PR review mode.
1. Run `gh pr view <number> --json state,isDraft` to check eligibility.
2. If the PR is closed, a draft, or trivially small (automated/bot PR), output: **"PR not eligible for review."** and stop.
3. Run `gh pr diff <number>` to get the diff. Use this instead of `git diff origin/main` for all subsequent steps.
4. Skip to Step 2.

**Otherwise:** Local branch review mode.
1. Run `git branch --show-current` to get the current branch.
2. If on `main`, output: **"Nothing to review — you're on main."** and stop.
3. Run `git fetch origin main --quiet && git diff origin/main --stat` to check if there's a diff.
4. If no diff, output: **"No changes against main. Nothing to review."** and stop.

---

## Step 2: Load Review Checklist

Read `.claude/skills/review/checklist.md`.

**If the file cannot be read, STOP and report:** "Review checklist not found. Run /configure-claude to install."

---

## Step 2.5: Greptile Comment Triage (conditional)

Only run this step if:
- `$ARGUMENTS` contains "greptile", OR
- A file exists at `$HOME/.claude/review/projects/$REMOTE_SLUG/greptile-history.md` for this repo
  (derive `REMOTE_SLUG` from `gh repo view --json nameWithOwner --jq '.nameWithOwner' | tr '/' '__'`)

Read `.claude/skills/review/greptile-triage.md` and follow the fetch, filter, classify, and escalation detection steps.

**If no PR exists, `gh` fails, API returns an error, or there are zero Greptile comments:** Skip this step silently. Greptile integration is additive — the review works without it.

**If Greptile comments are found:** Store the classifications (VALID & ACTIONABLE, VALID BUT ALREADY FIXED, FALSE POSITIVE, SUPPRESSED) — you will need them in Step 5.

---

## Step 3: Dispatch Parallel Review Agents

Dispatch **up to 9 parallel agents** in a single message using the Agent tool. Agents A–E always run. Agents F, G, H, and I are signal-gated — only dispatch them if the diff matches the gate.

### Signal gating (run these greps first)

Use the same diff source selected in Step 1:
- local mode: `git diff origin/main`
- PR mode: pipe the cached `gh pr diff <number>` output

```bash
# Cache the diff once so gating greps are cheap. Reuse the converse-mode diff when present;
# otherwise populate from the same source used in Step 1 (gh pr diff in PR mode, git diff
# origin/main in local mode). All gates read from $DIFF_FILE — do NOT re-shell out per gate.
DIFF_FILE="$CONVERSE_TMPDIR/diff.txt"
if [ ! -s "$DIFF_FILE" ]; then
  DIFF_FILE=$(mktemp)
  if [ -n "$PR_NUMBER" ]; then
    gh pr diff "$PR_NUMBER" > "$DIFF_FILE"
  else
    git diff origin/main > "$DIFF_FILE"
  fi
fi

# Agent F — silent failure hunter. `grep -c` always prints the count to stdout
# (0 on no match) and exits 1 on no match. Append `|| true` (not `|| echo 0`)
# to absorb the exit-1: `|| echo 0` would append a second "0" and produce a
# two-line "0\n0" string that breaks `-gt` tests, while bare `grep -c` would
# abort the script under `set -euo pipefail`. `|| true` gives the count without
# either failure mode.
F_COUNT=$(grep -cE 'catch|\.catch|fallback|onError|Result<' "$DIFF_FILE" || true)
# Agent G — type design review
G_COUNT=$(grep -cE 'interface |type |enum |class |struct ' "$DIFF_FILE" || true)
# Agent H — cross-module format consistency (any touched source file qualifies).
# Diff headers have the form "+++ b/path/to/file.ext" — grep those to count touched source files.
H_COUNT=$(grep -cE '^\+\+\+ b/.*\.(rs|ts|tsx|js|jsx|py|go|sql)$' "$DIFF_FILE" || true)
# Agent I — spec-contract deviation (branch has a matching spec).
# Strip standard feature-branch prefixes, then require an exact spec directory
# match. Do NOT fall back to "first spec under .claude/specs/" — for issue-driven
# branches (e.g. claude/<task>) the fallback grabs an unrelated spec and Agent I
# runs against the wrong contract. Better to skip cleanly when there's no match.
branch=$(git branch --show-current)
slug=$(echo "$branch" | sed -E 's#^(feat|fix|chore|refactor|feature)/##')
SPEC_DIR=""
[ -d ".claude/specs/$slug" ] && SPEC_DIR=".claude/specs/$slug"

# Also gate the versioned-struct pass inside Agent B:
VERSIONED_STRUCT=$(grep -cE '(_VERSION|version:\s*(number|u?[0-9]+))' "$DIFF_FILE" || true)
```

If the respective count is 0 (or `$SPEC_DIR` empty for Agent I), skip that agent.

**Agent A — Convention review (@code-reviewer):**
```text
prompt: "You are the @code-reviewer agent. Review the diff between origin/main and HEAD.

Follow the full code-reviewer workflow:
1. Run: git diff origin/main, git diff origin/main --name-only
2. Read all CLAUDE.md files in the repo
3. If .claude/specs/ exists, detect active spec from branch name
4. For each changed file, read 1-2 sibling files for pattern context
5. Run the review checklist: convention compliance, secrets, debug artifacts,
   dead code, error handling, spec alignment, pattern consistency, security

Produce your standard findings list with file:line references and severity
(critical/warning/info). Do NOT write any review stamp file.
Return findings only."
description: "Convention review (@code-reviewer)"
```

**Agent B — Checklist review (security + structural):**
```text
prompt: "Run a pre-landing code review on the diff between origin/main and HEAD.
Run `git diff origin/main` to get the full diff. Read the checklist at
.claude/skills/review/checklist.md. Apply the two-pass review:

Pass 1 (CRITICAL): SQL & Data Safety, Race Conditions & Concurrency,
LLM Output Trust Boundary, Auth & Security Boundaries.
Pass 2 (INFORMATIONAL): All remaining categories.
Signal-gated passes: read the 'Signal-Gated Passes' section of the checklist.
Run the versioned-struct pass ONLY if the diff matches the signals listed there
(const *_VERSION, struct field `version:`, or TS `version: number` on serialized types).

Respect the Suppressions section — do NOT flag items listed there.
Read the FULL diff before flagging anything.

Output format: 'Checklist Review: N issues (X critical, Y informational)'
followed by findings with file:line references and suggested fixes.
Categorize each as CRITICAL or INFORMATIONAL."
description: "Checklist review (security + structural)"
```

**Agent C — Git blame & history review:**
```text
prompt: "Review the changes between origin/main and HEAD using git history context.

1. Run `git diff origin/main --name-only` to get changed files.
2. For each changed file, run `git log --oneline -10 -- <file>` and
   `git blame -L <changed-lines> -- <file>` to understand the history.
3. Look for:
   - Code that was recently refactored and is being changed again (churn = risk)
   - Patterns that were deliberately established by previous commits
   - Bug fixes being undone or weakened by the current changes
   - TODO/FIXME/HACK comments in blamed lines that are relevant

Return a list of findings with file:line references. For each, include the
relevant git history context (commit hash + message) that makes it a concern.
Only flag issues where history provides insight — skip if history is clean."
description: "Git blame & history review"
```

**Agent D — Previous PR comment review:**
```text
prompt: "Check if previous PRs that touched these files had review comments
that may also apply to the current changes.

1. Run `git diff origin/main --name-only` to get changed files.
2. For each file (max 5), run:
   `gh pr list --state merged --search <filename> --limit 3 --json number`
3. For each found PR, fetch review comments:
   `gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | select(.path == \"<file>\") | {body: .body, line: .line}'`
4. Check if any previous review comments apply to the current changes
   (same patterns, same concerns, same files).

Return findings only if previous comments are genuinely relevant to the
current diff. Skip stale or inapplicable comments."
description: "Previous PR comment review"
```

**Agent E — Code comment compliance:**
```text
prompt: "Check that the changes between origin/main and HEAD comply with
code comments in the modified files.

1. Run `git diff origin/main --name-only` to get changed files.
2. For each changed file, read the full file and identify:
   - TODO/FIXME/HACK comments near changed lines
   - Docstrings or inline comments that describe expected behavior
   - Warning comments (e.g., 'DO NOT MODIFY', 'must be called before X')
3. Verify the changes don't violate any of these documented constraints.

Return findings with file:line references. Only flag genuine violations —
not stale comments about unrelated code."
description: "Code comment compliance"
```

**Agent F — Silent failure hunter (signal-gated: `$F_COUNT > 0`):**

Only dispatch if `$F_COUNT > 0` from the gate grep above (diff contains `catch`, `.catch`, `fallback`, `onError`, or `Result<`).

```text
prompt: "Hunt for silent failures in the target diff for this review.

Use the same diff source selected in Step 1:
- local mode: `git diff origin/main`
- PR mode: the `gh pr diff <number>` output already fetched
For every error-handling location in the changed code, scrutinize:

1. **Catch block specificity:** Does it catch only expected errors, or could
   it accidentally suppress unrelated errors? List every unexpected error type
   that could be hidden.
2. **Logging quality:** Is the error logged with enough context to debug
   6 months from now? Does it include what operation failed and relevant IDs?
3. **User feedback:** Does the user receive actionable feedback, or does the
   error vanish silently?
4. **Fallback behavior:** Is fallback logic explicitly justified, or does it
   mask the underlying problem? Would the user be confused by fallback behavior?
5. **Error propagation:** Should this error bubble up instead of being caught here?

Flag these patterns as CRITICAL:
- Empty catch blocks
- Catch blocks that only log and continue without user feedback
- Returning null/undefined/default on error without logging
- Broad exception catching that hides unrelated errors
- Retry logic that exhausts attempts without informing the user

Return findings with file:line, severity (CRITICAL/HIGH/MEDIUM),
issue description, hidden error types, and recommended fix."
description: "Silent failure hunter"
```

**Agent G — Type design review (signal-gated: `$G_COUNT > 0`):**

Only dispatch if `$G_COUNT > 0` from the gate grep above (diff introduces or modifies `interface`, `type`, `enum`, `class`, or `struct`).

```text
prompt: "Review type design in the target diff for this review.

Use the same diff source selected in Step 1:
- local mode: `git diff origin/main`
- PR mode: the `gh pr diff <number>` output already fetched
Find new or modified type definitions
(interfaces, types, enums, classes, structs).

For each new or significantly modified type, evaluate:

1. **Invariant expression:** Are constraints obvious from the type definition?
   Can illegal states be represented? Rate 1-10.
2. **Encapsulation:** Are internals properly hidden? Can invariants be
   violated from outside? Rate 1-10.
3. **Enforcement:** Are invariants checked at construction? Are all mutation
   points guarded? Rate 1-10.
4. **Usefulness:** Do the invariants prevent real bugs? Are they aligned
   with business requirements? Rate 1-10.

Flag these anti-patterns:
- Anemic types with no behavior or validation
- Types exposing mutable internals
- Invariants enforced only through documentation/comments
- Missing validation at construction boundaries
- Types that rely on external code to maintain invariants

Return findings with file:line, the type name, ratings, and specific
improvement suggestions. Keep suggestions pragmatic — don't overcomplicate."
description: "Type design review"
```

**Agent H — Cross-module format consistency (signal-gated: `$H_COUNT > 0`):**

Only dispatch if `$H_COUNT > 0` — the diff touches Rust, TypeScript/JavaScript, Python, Go, or SQL. The agent greps the **whole module** around each changed file — not just the diff — for consistency contracts and flags any mismatches.

```text
prompt: "Hunt for cross-module format-consistency drift in the target diff.

Use the same diff source selected in Step 1:
- local mode: git diff origin/main
- PR mode: the gh pr diff <number> output already fetched

1. Run `git diff origin/main --name-only` to get the changed files.
2. For each changed file, determine its module — the nearest enclosing directory
   that groups related files (e.g. `src-tauri/src/db/` for Rust, `src/features/foo/`
   for TS, `app/models/` for Ruby). Read every file in that module, not just the
   changed ones.
3. For each module, scan for these consistency contracts and flag mismatches:

   **Datetime writers (Rust / TS / JS / Python / Go / SQL).**
     - Rust: `datetime\\('now'\\)` vs `Utc::now\\(\\)` vs `chrono::Utc::now\\(\\)\\.to_rfc3339\\(\\)` vs `SystemTime::now\\(\\)`
     - TS/JS: `new Date\\(\\)\\.toISOString\\(\\)` vs `Date\\.now\\(\\)` vs `dayjs\\(\\)\\.format\\(` vs raw `Date\\(\\)`
     - Python: `datetime\\.utcnow\\(\\)` vs `datetime\\.now\\(tz=` vs `time\\.time\\(\\)`
     - SQL: `datetime\\('now'\\)` vs `CURRENT_TIMESTAMP` vs `NOW\\(\\)`
     If a single module writes timestamps using 2+ different functions, flag as CRITICAL — the serialized formats will diverge.

   **SQL ORDER BY directions.** Grep for the same column appearing in `ORDER BY <col> ASC` and `ORDER BY <col> DESC` within one module — if two handlers sort the same column differently, results will be inconsistent.

   **Serialization drift.** Grep for the same identifier written both snake_case and camelCase within one module (e.g. `created_at` and `createdAt` appearing on the same struct's serde attributes). Flag as CRITICAL — this causes silent deserialize failures.

4. Return findings with file:line, the inconsistent values found, and which
   module boundary they fall within. Only flag genuine mismatches — skip cases
   where different formats are intentional (e.g. a TS/serde boundary where
   snake↔camel is expected)."
description: "Cross-module format consistency"
```

**Agent I — Spec-contract deviation (signal-gated: `$SPEC_DIR` non-empty):**

Only dispatch if `$SPEC_DIR` is non-empty (branch slug matches a directory under `.claude/specs/` OR a spec with both `design.md` and `tasks.md` is found). If `$SPEC_DIR` is empty, skip this agent.

```text
prompt: "Check the diff for deviations from the spec contract.

1. Read $SPEC_DIR/design.md and $SPEC_DIR/tasks.md — these are the contract.
2. Run `git diff origin/main` (or the PR diff) to see what was built.
3. For each top-level item in design.md (new components, APIs, data flows, event names,
   field names) and each task in tasks.md:
   - Is it delivered in the diff? If a design.md bullet names a specific symbol,
     field, or event, grep the diff for it.
   - Is there extra work in the diff not covered by any spec item?

Flag two classes of deviation:
  - MISSING: spec promises it, diff doesn't deliver it.
  - EXTRA: diff builds it, spec doesn't describe it.

For each deviation, return:
  [file:line or spec-section] <deviation description>
  Recommendation: either (A) remediate — bring the diff back to the spec, or
                         (B) update spec — strikethrough the old bullet in
                             design.md/tasks.md and add an addendum describing
                             the current implementation path.
  Include the one-sentence reasoning for which option fits better.

Skip deviations that are obviously trivial (renaming a helper, moving a file).
Focus on behavioral contract: commands the system accepts, events it emits,
data shape it persists, failure modes it handles."
description: "Spec-contract deviation"
```

Wait for all agents to return (5 core + up to 4 signal-gated).

---

## Step 4: Merge, Score, and Filter Findings

1. Collect findings from all agents (5-9 depending on which conditional agents ran).
2. Deduplicate: if multiple agents flag the same file:line for the same issue, keep the one with most detail.
3. **Confidence score each finding** on a 0-100 scale:
   - **0-25:** Likely false positive — doesn't stand up to scrutiny, or is a pre-existing issue.
   - **25-50:** Might be real but unverifiable, or is a stylistic preference not backed by CLAUDE.md.
   - **50-75:** Real issue but minor — nitpick, rarely hit in practice, or low impact.
   - **75-100:** Verified real issue — will impact functionality, directly violates CLAUDE.md, or has historical evidence (git blame/previous PR comments support it).
4. **Filter out findings scoring below 60.** This eliminates noise and false positives.
5. Classify remaining findings: score ≥ 80 = CRITICAL, score 60-79 = INFORMATIONAL.
6. If Greptile triage ran in Step 2.5, append VALID & ACTIONABLE Greptile findings as CRITICAL items.

---

## Step 5: Present Findings

Output all findings:

```text
## Pre-Landing Review: N issues (X critical, Y informational)
[+ M Greptile comments (A valid, B fixed, C FP)]  ← only if Greptile ran

### CRITICAL (blocking) — confidence ≥ 80
1. [file:line] Problem description (score: 85)
   Fix: suggested fix
   Source: convention | checklist | blame | prev-PR | comments | silent-failure | type-design | format-consistency | spec-contract | greptile

### INFORMATIONAL (advisory) — confidence 60-79
1. [file:line] Problem description (score: 65)
   Fix: suggested fix
```

**For each CRITICAL finding (local mode only)**, use AskUserQuestion individually (one issue per call, not batched):
- A) Fix it now (recommended)
- B) Acknowledge and ship anyway
- C) False positive — skip

Lead with your recommendation and explain WHY.

**If user chose A (fix):** Describe the exact fix needed. Do NOT apply it — the skill is read-only. Tell the user to apply the fix and re-run `/review`.

**In PR mode:** skip the AskUserQuestion loop — findings are posted as a single consolidated comment in Step 7 for the PR author to address.

### Greptile Comment Resolution

After presenting your own findings, if Greptile comments were classified in Step 2.5:

1. **VALID & ACTIONABLE:** Already included in CRITICAL findings above — follows the same AskUserQuestion flow.

2. **FALSE POSITIVE:** Present each via AskUserQuestion:
   - Show the comment: file:line + body summary + permalink URL
   - Explain why it's a false positive
   - Options: A) Reply to Greptile explaining why incorrect (recommended), B) Fix it anyway, C) Ignore
   - If user chose A, reply using the False Positive template from greptile-triage.md

3. **VALID BUT ALREADY FIXED:** Reply using the Already Fixed template — no AskUserQuestion needed.

4. **SUPPRESSED:** Skip silently.

Write triage outcomes to history files as documented in greptile-triage.md.

---

## Step 5.5: Flow Diagram

Generate a **Mermaid diagram** showing the key flow introduced or changed in this diff. Pick the diagram type that fits best:

- `sequenceDiagram` — for request/response flows, multi-step pipelines, hook execution chains
- `flowchart TD` — for decision trees, state machines, before/after architecture comparisons
- `stateDiagram-v2` — for entity lifecycle or state transitions

**Rules:**
- Read the full diff first. Only diagram **new/changed flows**, not the entire system.
- 5-15 nodes max. If the PR is small (< 50 lines, config-only, docs-only), skip this step.
- Include error paths where the diff introduces error handling.

**If a PR exists** (check with `gh pr view --json number --jq '.number'`):
In **local mode**, post the diagram as a standalone PR comment using `gh`:

```bash
gh pr comment <number> --body "$(cat <<'EOF'
## Flow Diagram

```mermaid
<diagram>
```

_Auto-generated by `/review`_
EOF
)"
```

**If no PR exists** (reviewing before push): Include the diagram in the Step 5 output instead.

**In PR mode:** Do NOT post the diagram as a separate comment here — Step 7 embeds it in the single consolidated review comment to avoid double-posting.

---

## Step 5.6: TODO Cross-Reference

Check for `TODO.md` or `TODOS.md` in the repository root. If found:

- Does this PR close any open TODOs? Note: "This PR addresses TODO: <title>"
- Does this PR introduce work that should become a TODO? Flag as informational.
- Are there related TODOs that provide context? Reference them alongside related findings.

If no TODO file exists, skip silently.

---

## Step 6: Write Review Stamp

**If no unresolved CRITICAL findings** (all resolved as B/C, or none existed):

Compute the diff hash and write the review stamp. The hash covers BOTH `git diff origin/main` (committed-vs-main) AND `git diff` (unstaged drift) so staging/unstaging after the stamp can't mask a stale review. The node snippet below uses `execFileSync` with an explicit argv array — git arguments are passed as array elements, not interpolated into a shell string — which is safer and passes repo security hooks:

```bash
node -e "
  const crypto = require('crypto');
  const { execFileSync } = require('node:child_process');
  const fs = require('fs');
  const path = require('path');
  const diff = execFileSync('git', ['diff', 'origin/main'], { encoding: 'utf8' });
  const unstaged = execFileSync('git', ['diff'], { encoding: 'utf8' });
  const hash = crypto.createHash('sha256').update(diff + unstaged).digest('hex');
  const reviewDir = path.join(process.cwd(), '.claude');
  if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, '.last-review'), JSON.stringify({
    diffHash: hash,
    reviewedAt: new Date().toISOString(),
    reviewer: '/review'
  }) + '\n');
  console.log('Review stamp written: ' + hash.slice(0, 12) + '...');
"
```

**If any CRITICAL finding was resolved with "Fix it now":** Do NOT write the stamp. The user needs to apply fixes and re-run `/review`.

**If in PR mode (`/review pr <number>`):** Do NOT write the stamp — there's no local staged diff to hash.

---

## Step 7: Post PR Comment (PR mode only)

**If in PR mode (`/review pr <number>`):** Always post all findings as a **single consolidated comment** on the PR — do not post multiple comments, and do not run the interactive AskUserQuestion loop (that's local-mode only).

Format the full review output (from Step 5, plus the Step 5.5 flow diagram if generated) as one PR comment:

```bash
gh pr comment <number> --body "$(cat <<'EOF'
## Pre-Landing Review

<full review findings from Step 5, formatted as markdown>

<flow diagram from Step 5.5, if generated — embed it here rather than posting separately>

### Summary
Review complete: PASS | N informational notes
— or —
Review complete: BLOCKED | N critical issues need resolution

---
*Automated review by `/review pr <number>`*
EOF
)"
```

**Do NOT make code changes in PR mode.** The review is read-only — findings are posted as a comment for the PR author to address. Only make changes if the user explicitly asks you to fix something.

**If in local mode:** Skip this step (no PR to comment on; the interactive AskUserQuestion loop in Step 5 handled it).

---

## Step 8: Summary

```text
Review complete: PASS | N informational notes
```
or
```text
Review complete: BLOCKED | N critical issues need resolution
```

If in PR mode, confirm the comment was posted:
```text
Review findings posted as comment on PR #<number>.
```

---

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed in the diff.
- **Read-only by default.** Only write the review stamp file (local mode) or post a PR comment (PR mode). Never modify code, commit, push, or create PRs.
- **PR mode is comment-only.** Post findings as a single PR comment. Do not make code changes unless the user explicitly asks.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine. Respect the suppressions list.
- **One issue per AskUserQuestion.** Never batch multiple issues into one question (local mode only — in PR mode, post all findings in a single comment).

## Gotchas

- **REMOTE_SLUG uses `tr '/' '__'`** to preserve the owner in the path (e.g., `owner__repo`). Don't use just the repo name.
- **Greptile auto-detect is repo-scoped, not wildcard.** The history file path includes the full `REMOTE_SLUG`, so it only activates for repos that have been triaged before. First run for a repo needs the explicit `/review greptile`.
- **The review stamp hashes `git diff origin/main` + `git diff`** (both committed-vs-main and unstaged drift). If you stage/unstage files after the stamp, the review gate will see a mismatch — by design, so unstaged changes can't mask a stale stamp. Stage everything before running `/review`.
- **If the checklist file is missing**, the skill stops early. Run `/configure-claude` to install it.
- **Flow diagram posts to PR as a separate comment in local mode** (when a PR exists), or is embedded inline in Step 5 if no PR. In PR mode, Step 7 folds the diagram into the single consolidated review comment to avoid double-posting. Skip for trivial diffs (< 50 lines, config-only, docs-only).
- **Confidence scoring filters noise.** Findings below 60 are dropped entirely. Don't lower the threshold to include more — the cutoff exists to prevent false positive fatigue.
- **Git blame agent may be slow on large files.** It runs `git blame` per changed file — on files with thousands of lines, this takes time. The parallel agents run simultaneously so it doesn't block the others.
- **PR mode (`/review pr <number>`)** fetches the diff from GitHub, not the local branch. The review stamp is NOT written in PR mode (there's no local staged diff to hash). Findings are posted as a single consolidated PR comment, not an interactive question loop.
- **Multi mode spawns independent Claude instances.** Each `--multi` pane runs `/review pr <n>` in a fresh context — they cannot coordinate findings. Use when you want unbiased parallel reviews; use single-instance mode when you want one consolidated summary.
- **Signal gating uses grep counts, not heuristics.** If `$F_COUNT` / `$G_COUNT` / `$H_COUNT` is 0, the agent does not run. This prevents wasted agent budget on irrelevant diffs. Spec-contract gating uses directory existence rather than a count.
- **Stamp script uses `execFileSync` with argv, not a shell-string runner.** Git arguments go in as an array so nothing gets shell-interpolated — no injection surface, and security hooks that block shell-interpolated child-process calls still allow the argv form.
- **Converse mode requires the adversary CLI installed.** `codex` needs `npm i -g @openai/codex`, `gemini` needs the Google CLI. The skill checks `command -v <cli>` and stops early if missing.
- **Converse mode uses unquoted heredocs** (`<<PROMPT_EOF`, not `<<'PROMPT_EOF'`) so `$(cat ...)` and `${VAR}` expand. The diff content is read from a temp file via `$(cat "$CONVERSE_TMPDIR/diff.txt")` — never passed as a shell argument.
- **Large diffs may exceed adversary context limits.** If the diff is >5000 lines, consider using `--stat` summary + key files instead of the full diff. The skill doesn't auto-truncate — watch for CLI errors.
- **Adversary model selection:** Use `cli:model` syntax (e.g., `codex:o3`, `claude:sonnet`). If omitted, the CLI's default model is used. Some models may not be available on all accounts — if the adversary fails with a model error, retry without the model suffix or try a different model.
- **Adversary CLI allowlist:** Only `codex`, `gemini`, and `claude` are accepted. Passing any other CLI via `--converse` is rejected to prevent arbitrary command injection from `$ARGUMENTS`.
