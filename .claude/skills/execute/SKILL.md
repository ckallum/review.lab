---
_origin: calsuite@2a7c883
name: execute
version: 2.1.0
description: |
  execute this, build this, implement this, start coding, run the plan,
  implement tasks, work through the plan, execute tasks, build from spec,
  execute issue, work on issue, implement issue, just do it.
  Three modes: RAW (execute from conversation context), SPEC (task-by-task
  from spec with full compliance review), ISSUE (fetch GitHub issue and implement).
  Multi mode: /execute --multi issue:1,2,3 or /execute --multi spec:a,b spawns parallel tmux panes.
argument-hint: "[spec <slug> | issue <number>] | --multi issue:<n>,<n>,... | --multi spec:<slug>,<slug>,..."
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - Skill
---

# Execute

Flexible execution skill with three modes plus a parallel multi-pane launcher. All modes share the same execution engine — the only difference is how tasks are sourced and what the compliance reviewer checks against.

## AFK vs HITL handling (shared)

See `/guardian`'s "How AFK/HITL composes across skills" section for the authoritative definitions and how the label cascades from `/sweep-issues` (classification) through here (execution) to `/guardian` (permissions). At this layer:

- **AFK-labelled task** (issue carries `afk`, or spec/conversation marks it AFK): proceed end-to-end through the execution loop without pausing for confirmation between phases.
- **HITL-labelled task**: pause at each decision point and ask via AskUserQuestion before proceeding.
- **Unlabelled**: behave as HITL — only escalate to AFK when explicitly marked or when the user is running under `/guardian mode autonomous`.

### Resolving the mode (compute once, use everywhere)

Compute a single `MODE` value at the start of execution and reuse it at every AskUserQuestion call site below:

```bash
# Pseudocode — adapt to the actual decision flow
MODE=hitl                                          # default
issue_has_label_afk && MODE=afk                    # ISSUE mode: read labels
spec_or_user_marks_afk && MODE=afk                 # SPEC / RAW mode: explicit marker
guardian_mode_is_autonomous && MODE=afk            # session-wide override
```

### AskUserQuestion gating rule

Every AskUserQuestion call below falls into one of two categories:

| Category | AFK behavior | HITL behavior |
|---|---|---|
| **Phase confirmation** — "proceed?", "continue?", "raise concerns?" between phases | **Skip** the prompt; proceed automatically and log the auto-decision in the batch report | Ask normally |
| **User-owned decision** — actions that change shared state outside this run (close issue, post comment, push to remote, send notification) | **Always ask** regardless of mode — AFK does not authorize state changes the user hasn't explicitly delegated | Ask normally |

Each AskUserQuestion call site below explicitly states which category it belongs to. The default for ambiguous calls is **phase confirmation** (skippable in AFK) — be conservative about marking a call user-owned, but never auto-execute issue-close, force-push, or external-system writes without explicit user confirmation.

## Domain awareness (shared, runs before any mode)

If the repo has a `CONTEXT.md` (or a `CONTEXT-MAP.md` at the root pointing to per-module `CONTEXT.md` files), read it. **Use its vocabulary verbatim** in commit messages, test names, function/variable names, PR descriptions, and any user-facing text. The glossary is the project's source of truth for naming — drift defeats the point.

If `docs/adr/` (or `<context>/docs/adr/`) exists and contains ADRs touching the area you're modifying, read them. Do not implement changes that contradict an accepted ADR without first surfacing the conflict to the user.

Pass any relevant `CONTEXT.md` excerpts and ADR references into the implementer-agent prompt as part of `COMPLIANCE_REFERENCE` so the agent uses the same vocabulary.

```
/execute                              → RAW mode   (execute from conversation context)
/execute spec <slug>                  → SPEC mode  (execute from .claude/specs/<slug>/)
/execute issue <number>               → ISSUE mode (execute from GitHub issue)
/execute --multi issue:1,2,3          → MULTI mode (one tmux pane per issue)
/execute --multi spec:foo,bar         → MULTI mode (one tmux pane per spec)
```

---

## Step 0: Mode Selection

**If `$ARGUMENTS` contains `--multi`:** Jump to **Step 0M** (Multi Mode).

Otherwise, parse `$ARGUMENTS`:
- Empty → **RAW** mode
- Starts with `spec` → **SPEC** mode (extract slug from remaining args, e.g., `/execute spec auth-flow` → slug = `auth-flow`)
- Starts with `issue` → **ISSUE** mode (extract number from remaining args, e.g., `/execute issue 42` → number = `42`)
- Any other non-empty value → **STOP** and tell the user: "Unknown mode. Use `/execute`, `/execute spec <slug>`, `/execute issue <number>`, or `/execute --multi issue:<n>,<n>,...`."

---

## Step 0M: Multi Mode

`--multi` means "new tmux pane, clean context" — each issue or spec gets its own Claude Code instance executing independently.

1. Parse the argument after `--multi`. It must be one of:
   - `issue:<n>,<n>,...` — comma-separated issue numbers
   - `spec:<slug>,<slug>,...` — comma-separated spec slugs

   If neither form matches (or no identifiers follow), STOP and tell the user: "`--multi` requires `issue:<numbers>` or `spec:<slugs>`. Raw prompts are not supported."

2. Verify tmux is available and we're inside a tmux session:
   ```bash
   tmux display-message -p '#S:#I' 2>/dev/null
   ```
   If this fails, STOP and tell the user: "`--multi` requires an active tmux session. Start tmux first, then re-run."

3. Capture the current session and window (e.g. `mysession:0`).

4. For each identifier in the comma-separated list, create a new tmux pane and launch a Claude Code instance:

   ```bash
   # For ISSUE mode — each issue gets its own pane:
   tmux split-window -t "$SESSION:$WINDOW" -h \
     "claude --dangerously-skip-permissions --print 'Run /execute issue <NUMBER>. Implement the issue fully — derive tasks, execute, commit, and report when done.' 2>&1; echo '--- Execution of issue #<NUMBER> complete. Press Enter to close. ---'; read"
   tmux select-layout -t "$SESSION:$WINDOW" tiled

   # For SPEC mode — each spec gets its own pane:
   tmux split-window -t "$SESSION:$WINDOW" -h \
     "claude --dangerously-skip-permissions --print 'Run /execute spec <SLUG>. Execute the spec fully — work through all tasks, commit, and report when done.' 2>&1; echo '--- Execution of spec <SLUG> complete. Press Enter to close. ---'; read"
   tmux select-layout -t "$SESSION:$WINDOW" tiled
   ```

5. Output:
   ```text
   Multi execution launched:
     Mode: [issue | spec]
     Items: #1, #2, #3  (or foo, bar, baz)
     Panes: N new tmux panes created
     Each instance executes independently with full review cycles.

   Watch progress in the tmux panes. This instance is done.
   ```

6. **STOP.** Do not proceed to Step 1 — the tmux instances handle the execution.

---

## Step 1: Task Sourcing (mode-specific)

### RAW Mode

1. Summarize what the user wants from conversation context into a concrete task list.
2. Explore the codebase to understand relevant files, patterns, and conventions.
3. Break the work into discrete, ordered tasks (same format as `tasks.md`).
4. **Phase confirmation** — present via AskUserQuestion **only if `MODE=hitl`**; in AFK mode, accept the derived task list and the 2-3 sentence intent summary as `COMPLIANCE_REFERENCE` automatically and log the auto-decision in the eventual batch report:

> Here's what I understand you want to implement:
> - Task 1: [description]
> - Task 2: [description]
> - Task 3: [description]
>
> **COMPLIANCE_REFERENCE** (what I'll check the implementation against):
> "[2-3 sentence summary of intent]"
>
> A) Proceed  B) Let me clarify

Store the confirmed (or auto-accepted) summary as `COMPLIANCE_REFERENCE`.

### SPEC Mode

1. Find the spec using the slug parsed in Step 0 (e.g., `auth-flow` → `.claude/specs/auth-flow/`). If no slug was provided after `spec`, use the most recent spec in `.claude/specs/`. Read all spec files:
   - `requirements.md`
   - `design.md`
   - `tasks.md`
   - `diagrams.md` (if exists — generated by `/plan visualize`)

2. **If `tasks.md` doesn't exist or has no tasks:** Stop. "No tasks found. Run `/plan review` first to generate tasks."

3. Store `requirements.md` + `design.md` content as `COMPLIANCE_REFERENCE`.

### ISSUE Mode

1. Fetch the issue:
```bash
gh issue view <number> --json title,body,labels,comments,assignees
```

2. Parse the issue body:
   - If it contains checklists (`- [ ]` items), extract them as tasks directly.
   - If prose only, derive discrete tasks (same approach as RAW mode).

3. **Phase confirmation** — present via AskUserQuestion **only if `MODE=hitl`**; in AFK mode, accept the derived task list automatically:

> Issue #N: **<title>**
> Tasks derived from the issue:
> - Task 1: [description]
> - Task 2: [description]
>
> A) Proceed  B) Let me clarify

4. Store issue title + body + comments as `COMPLIANCE_REFERENCE`.

---

## Step 2: Pre-flight + Branch (shared)

1. Read CLAUDE.md for project conventions.
2. Review the task list critically — are tasks ordered correctly? Are dependencies satisfied?
3. Check the current branch. If on `main`/`master`, create a feature branch:
   - **SPEC:** `feat/<slug>`
   - **ISSUE:** `feat/<issue-number>-<slugified-title>` (max 50 chars)
   - **RAW:** Ask user or derive from first task description
4. **Phase confirmation** — raise any concerns via AskUserQuestion before starting **only if `MODE=hitl`**. In AFK mode, log concerns to the batch report and proceed; if a concern is severe enough that proceeding would corrupt state (uncommitted changes that conflict, missing dependencies, branch-protection issues), STOP regardless of mode and report — that's a hard blocker, not a phase prompt.

---

## Step 3: Execution Loop (shared)

Execute tasks sequentially, reporting progress in batches of 3. For each task:

### 3a: Dispatch implementer agent

```text
prompt: "You are implementing a task. Read CLAUDE.md first.

TASK:
<full task text — never make the agent read a file>

CONTEXT:
<COMPLIANCE_REFERENCE content — spec sections, issue body, or user summary>

DIAGRAMS:
<relevant diagrams from diagrams.md, if they exist (SPEC mode only)>

Instructions:
1. If anything is unclear, list your questions and STOP — do not guess.
2. Implement exactly what the task specifies. Nothing more, nothing less.
3. Write tests for new functionality.
4. Run tests to verify they pass.
5. Commit your changes with a descriptive message.
   ISSUE mode: include 'Refs #<number>' in commit message.
6. Self-review: check completeness, code quality, test coverage.

Return: what you implemented, what tests you wrote, test results, any concerns."
description: "Implement task: <task title>"
```

**If the agent has questions:** treat as a hard blocker. In `MODE=hitl`, present via AskUserQuestion, answer, then re-dispatch. In `MODE=afk`, the orchestrator does **not** have the user's input — STOP and report: *"Task `<title>` requires HITL clarification: `<questions>`. Re-run as HITL or label the issue `hitl` and re-execute."* Do not guess; do not skip; do not silently stall waiting for input that won't come.

### 3b: Dispatch compliance reviewer

After the implementer finishes:

```text
prompt: "You are reviewing an implementation for compliance. Read the actual code changes (git diff), not just the implementer's report.

TASK THAT WAS IMPLEMENTED:
<full task text>

COMPLIANCE REFERENCE:
<COMPLIANCE_REFERENCE — spec requirements, issue body, or user summary>

Check:
- Did the implementer build exactly what was requested?
- Is anything missing from the requirements?
- Is there extra/unneeded work beyond the task scope?
- Do the tests cover the requirements?

Report: ✅ Passes compliance, or ❌ with specific file:line issues."
description: "Compliance review: <task title>"
```

**If issues found:** Re-dispatch the implementer with the specific issues. Re-review after fixes. Max 2 fix cycles — if still failing, escalate to user.

### 3c: Dispatch code quality reviewer

Only after compliance passes:

```text
prompt: "You are reviewing code quality. Read CLAUDE.md first, then review the changes.

Run: git diff origin/main --name-only to find changed files. Read each changed file.

Check:
- Does the code follow project conventions from CLAUDE.md?
- Are there DRY violations, unnecessary complexity, or missing error handling?
- Could existing utilities be reused instead of new code?
- Are there security concerns?

Report: list of issues (Critical/Important/Minor) with file:line references and suggested fixes."
description: "Quality review: <task title>"
```

**If critical issues found:** Fix them (or dispatch implementer to fix). Re-review.

### 3d: Simplify

After quality review passes, run `/simplify` to clean up the changed code — reuse opportunities, clarity, consistency. This ensures the final code is polished before marking the task complete.

### 3e: Mark task complete

- **SPEC mode:** Update `tasks.md` — check off the completed task.
- **ISSUE/RAW mode:** Track completion internally (no tasks.md to update).

---

## Step 4: Batch Checkpoint (shared)

After each batch of 3 tasks, report to the user. **Phase confirmation** — present the "Continue?" prompt via AskUserQuestion **only if `MODE=hitl`**; in AFK mode, log the batch report and continue automatically to the next batch:

```text
Batch N complete: tasks X-Y done
  Implemented: [summary of each task]
  Compliance reviews: all passed (or N fix cycles needed)
  Quality reviews: N issues found and fixed
  Tests: all passing

Next batch: tasks Y+1 to Z
Continue? (A) Yes  (B) Review changes first  (C) Stop here     ← MODE=hitl only
```

---

## Step 5: Completion (shared, with mode-specific updates)

After all tasks are done:

1. Run the full test suite.
2. Mode-specific updates:
   - **SPEC:** Update `tasks.md` with all checkboxes checked. If `CHANGELOG.md` exists, update it; otherwise skip.
   - **ISSUE:** Comment on the issue:
     ```bash
     gh issue comment <number> --body "Implementation complete on branch \`$(git branch --show-current)\`. Changes: <summary of files changed and tests written>"
     ```
     **User-owned decision** — always ask via AskUserQuestion regardless of `MODE`: "Close this issue? (A) Yes (B) No, keep open until PR merges". Closing an issue is a state change visible outside this run; AFK does not authorize it.
   - **RAW:** No external updates.
3. Report final status:

```text
Execution complete:
  Mode: <RAW|SPEC|ISSUE>
  Tasks: N/N completed
  Test suite: passing
  Fix cycles: N total across all tasks

Ready for /review and /ship
```

---

## Step 6: Optional PR (shared)

If creating a PR directly (instead of handing off to `/ship`):

1. Read the PR body template at `.claude/skills/ship/pr-template.md`
2. Follow the template structure: Summary, How It Works, Important Files, Test Results, Pre-Landing Review, Doc Completeness
3. **ISSUE mode:** Add `Closes #<number>` to the PR body
4. Create the PR using `gh pr create` with the formatted body
5. Output the PR URL

---

## Gotchas

- **Never start implementing on main/master.** Always create a feature branch first.
- **The compliance reviewer checks against `COMPLIANCE_REFERENCE`** — this is spec docs in SPEC mode, issue body in ISSUE mode, or user-confirmed summary in RAW mode. Same reviewer, different reference material.
- **Compliance review BEFORE quality review.** No point polishing code that doesn't match the requirements.
- **Include full task text in agent prompts.** Never tell the agent to "read tasks.md" — fresh agents don't have your context.
- **Max 2 fix cycles per review stage.** If it's still failing after 2 rounds, the task spec is probably unclear — escalate to the user.
- **Tasks must execute sequentially within a single pane.** Unlike parallel review agents, implementation tasks often have dependencies. Never dispatch multiple implementers in parallel inside one execution. (For independent issues/specs, use `--multi` to split across panes instead.)
- **Issue mode requires `gh` CLI.** If `gh` is not installed or not authenticated, abort with instructions.
- **Never auto-close issues.** Always ask the user first.
- **RAW mode depends on conversation context.** If the conversation has no clear task, ask the user to describe what they want.
- **Issue checklist parsing:** If the issue body has `- [ ]` items, use them as tasks directly. If prose only, derive tasks like RAW mode.
- **`--multi` only works with `issue:` and `spec:`** — raw prompts have no identifier to split on. If the user passes `--multi` without an `issue:` or `spec:` list, abort and ask them to specify identifiers.
- **`--multi` requires an active tmux session.** It uses `tmux split-window` to spawn panes — outside tmux there's nowhere to put them. Check `tmux display-message` before spawning.
