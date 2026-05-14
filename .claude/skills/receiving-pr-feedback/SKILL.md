---
_origin: calsuite@2a7c883
name: receiving-pr-feedback
version: 1.0.0
description: |
  PR feedback, review comments, code review response, address review, respond to feedback,
  handle reviewer suggestions, fix review comments, CR feedback.
  Rigorous handling of PR review feedback — verify before implementing, push back when wrong.
  Multi-PR mode: /receiving-pr-feedback 323,324,325 --multi spawns separate Claude Code instances per PR.
argument-hint: "[pr-number[,number,...]] [--multi]"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# Receiving PR Feedback

Handle PR review feedback with technical rigor. Verify suggestions before implementing, push back when they're wrong, and never blindly agree.

## Step 0: Multi-PR Mode

**If `$ARGUMENTS` contains `--multi`:**

`--multi` means "new tmux pane, clean context" — works with one PR or many. Each PR gets its own Claude Code instance with a fresh context window.

1. Parse PR numbers from arguments (single number like `323` or comma-separated like `323,324,325`).
2. Get the current tmux window: `tmux display-message -p '#S:#I'`
3. For each PR number, create a new tmux pane and launch a Claude Code instance:

```bash
# For each PR number in the list:
tmux split-window -t "$SESSION:$WINDOW" -h "claude --dangerously-skip-permissions --print 'Run /receiving-pr-feedback <NUMBER>. Process all review feedback, apply fixes, and reply to comments on the PR.' 2>&1; echo '--- PR #<NUMBER> feedback complete. Press Enter to close. ---'; read"
tmux select-layout -t "$SESSION:$WINDOW" tiled
```

4. Output:
```text
Multi-PR feedback launched:
  PRs: #323, #324, #325
  Panes: 3 new tmux panes created
  Mode: context-free — each instance handles feedback independently

Watch progress in the tmux panes. This instance is done.
```

5. **STOP.** Do not proceed to Step 1 — the tmux instances handle the feedback.

---

## Step 1: Load feedback

If a PR number is in `$ARGUMENTS`, fetch ALL comment types:

```bash
# Issue-level comments (general PR discussion, including /review bot comments)
gh pr view <number> --comments --json comments,reviews,reviewDecision

# Inline review comments (line-level code review feedback)
gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | {id: .id, path: .path, line: .line, body: .body, user: .user.login}'

# Top-level issue comments (general discussion not tied to specific lines)
gh api repos/{owner}/{repo}/issues/<number>/comments --jq '.[] | {id: .id, body: .body, user: .user.login}'
```

**Important:** PRs have TWO comment APIs — `/pulls/.../comments` for inline review comments and `/issues/.../comments` for general discussion. Both must be fetched. Automated review bots (like `/review pr`) post to issue comments, not inline comments.

If no PR number, check the current branch:
```bash
gh pr view --json number,comments,reviews
```

## Step 2: Classify each comment

For each review comment, classify it:

| Type | Action |
|---|---|
| **Bug / correctness issue** | Verify it's real, then fix |
| **Style / convention** | Check if it matches project conventions (read CLAUDE.md), then fix or push back |
| **Architecture suggestion** | Evaluate tradeoffs before acting |
| **Question / clarification** | Answer it |
| **Nitpick** | Fix if trivial, skip if subjective |
| **Wrong / outdated** | Push back with evidence |

## Step 2.5: Clarify ALL unclear items first

Before implementing anything, check if any comments are unclear or ambiguous. If so, **stop and ask for clarification on ALL unclear items before touching any code.**

Items may be related — partial understanding leads to wrong implementation.

```
IF you understand items 1,2,3,6 but not 4,5:
  ❌ WRONG: Implement 1,2,3,6 now, ask about 4,5 later
  ✅ RIGHT: "Understand 1,2,3,6. Need clarification on 4 and 5 before implementing."
```

---

## Step 3: Process each comment

For each comment, follow this protocol:

### Verify first — never blindly implement

1. **Read the code** the reviewer is commenting on. Understand the full context.
2. **Check if they're right.** Run the code path mentally or with a test. Does their suggestion actually improve things?
3. **Check for side effects.** Will the suggested change break something else?

### Forbidden responses

Never say:
- "You're absolutely right!"
- "Great catch!" (unless it genuinely is)
- "I'll fix that right away" (before verifying)

Instead: verify, then respond with facts.

### When to push back

Push back when a suggestion:
- **Breaks functionality** — "This would break X because Y. The current approach handles Z."
- **Lacks context** — "This pattern is intentional because [reason from spec/CLAUDE.md]."
- **Violates YAGNI** — grep the codebase for actual usage. "This endpoint isn't called anywhere. Remove it (YAGNI)? Or is there usage I'm missing?"
- **Is technically incorrect** — "This would actually cause [problem]. Here's why: [evidence]."
- **Conflicts with project conventions** — "CLAUDE.md specifies [convention]. Should we update the convention instead?"

### When to accept

Accept when:
- The suggestion is correct and you can verify it
- It catches a real bug or edge case
- It aligns with project conventions you missed

Acknowledge with brief, factual statements: "Fixed — the null check was missing." Not: "Wonderful suggestion, you're so right!"

## Step 4: Apply fixes

Implement in this order:
1. **Blocking issues** (breaks, security) — fix first
2. **Simple fixes** (typos, imports, one-liners) — batch these
3. **Complex fixes** (refactoring, logic changes) — one at a time, test each

For each accepted comment:
1. Make the fix
2. Test it (run relevant tests to verify no regression)
3. Reply on the PR with what you changed (one-liner)

```bash
gh api repos/{owner}/{repo}/pulls/<number>/comments/<comment-id>/replies -f body="Fixed — added null check for empty array case."
```

For each rejected comment, reply with your reasoning:

```bash
gh api repos/{owner}/{repo}/pulls/<number>/comments/<comment-id>/replies -f body="This is intentional — [reason]. Happy to discuss if you see an issue I'm missing."
```

## Step 4.5: Update PR Description

After fixes are applied and commits pushed, update the PR description to reflect the current state. Both `/ship` (Step 8) and this skill follow the same PR body structure defined in `.claude/skills/ship/pr-template.md`.

### Compute summary data first

Before updating the description, tally the results from Steps 3-4:
- **Accepted count**: number of comments where fixes were applied
- **Pushed back count**: number of comments rejected with reasoning
- **Questions answered count**: number of clarification replies

These counts are used in both the Revision History entry (below) and the final user summary (Step 5).

### Update procedure

**a. Fetch current PR body:**

```bash
gh pr view <number> --json body --jq '.body'
```

**b. Parse into sections:**

Split the body on `^## ` at line start (regex). This yields:
- **Preamble**: any text before the first `## ` header
- **Sections**: each `## Header` + content until the next `## ` or EOF

Identify sections by header name. Known sections: Summary, How It Works, Important Files, Test Results, Pre-Landing Review, Development Flow, Doc Completeness, Revision History. Unknown sections are preserved in their original position.

Reference implementation: `.claude/scripts/lib/pr-body-parser.cjs` (parsePrBody / assemblePrBody). Path is relative to the target project's `.claude/` directory — the installer places calsuite's `scripts/lib/` there. In calsuite itself, the source file lives at `scripts/lib/pr-body-parser.cjs`.

**c. Regenerate dynamic sections:**

- **Summary**: Analyze all commits on the branch (`git log origin/main..HEAD --oneline`) and generate updated bullet points summarizing what shipped.
- **Important Files**: Run `git diff origin/main --stat` and rebuild the file/change table matching the format in `pr-template.md`.
- **Test Results**: Re-run the project's test suites and rebuild the results table. Omit suites that weren't run.
- **Development Flow**: If `.claude/flow-trace-${CLAUDE_SESSION_ID:-unknown}.jsonl` exists, regenerate the Mermaid diagram. If no trace file exists, skip this section entirely. The `:-unknown` fallback matches the default used by calsuite's session-scoped trackers when `CLAUDE_SESSION_ID` is unset.

**d. Preserve static sections as-is (do not regenerate):**

- `## How It Works`
- `## Pre-Landing Review`
- `## Doc Completeness`
- Any custom/unknown sections not in the known list

**e. Build and append Revision History entry:**

If a `## Revision History` section exists, append to it. If not, create it after `## Doc Completeness` (or at the end if Doc Completeness is missing).

```markdown
## Revision History

**Round N** (YYYY-MM-DD):
- Accepted: X comments — brief list of key changes made
- Pushed back: Y comments
- Questions answered: Z comments
```

Round number = count of lines in the Revision History section matching the anchored regex `^\*\*Round \d+\*\*` (line start, literal `**Round `, one or more digits, literal `**`), plus 1. This avoids false matches inside prose or HTML comments. Date = today's date.

**f. Update the PR:**

Reassemble the body from the parsed/modified sections, then write it to a temp file and update the PR. Use the `Write` tool to write the assembled body — this avoids heredoc sentinel collisions (a PR body can legitimately contain a line that is literally `EOF`, which would terminate a `<<'EOF'` heredoc early):

```bash
# 1. Create the temp file path
tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

# 2. Write the reassembled body to $tmp_body using the Write tool
#    (not a shell heredoc — sentinels can collide with body content)

# 3. Update the PR from the file
gh pr edit <number> --body-file "$tmp_body"
```

## Step 5: Summary

Report to the user:
```text
PR #N feedback processed:
  Accepted: X comments (fixes applied)
  Pushed back: Y comments (replies posted)
  Questions answered: Z comments
  PR description: updated with revision round N
```

## Gotchas

- **Never batch-accept all comments.** Process each individually. Reviewers are sometimes wrong.
- **YAGNI check every "make it more professional" suggestion.** If it adds complexity for hypothetical future use, push back.
- **Read the full diff context, not just the commented line.** Reviewers sometimes miss surrounding code that explains the pattern.
- **If the reviewer and you disagree, escalate to the user** via AskUserQuestion rather than going back and forth.
