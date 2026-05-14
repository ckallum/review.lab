---
_origin: calsuite@2a7c883
name: prevent
version: 1.0.0
description: |
  prevent this, never again, stop this from happening, how do we prevent,
  make sure this doesn't happen, enforce this, guard against, catch this earlier,
  deterministic prevention, add a guardrail, add a check.
  Analyze a mistake or anti-pattern, find the most deterministic prevention
  mechanism, implement it, and create a tracking issue.
argument-hint: "[description of what went wrong]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - AskUserQuestion
---

# Prevent

Analyze a mistake or anti-pattern, find the most deterministic prevention mechanism available, implement it, and create a GitHub issue if needed.

## Invocation

```
/prevent                                          # Analyze the most recent mistake in conversation
/prevent "absolute paths in settings.json"        # Prevent a specific pattern
/prevent "reviewer said X but they were wrong"    # Encode pushback guidance
```

## Step 1: Identify the Problem

If `$ARGUMENTS` is provided, use it. Otherwise, scan the conversation for the most recent:
- Mistake Claude made that the user corrected
- Bug or anti-pattern discovered during development
- Review feedback that revealed a gap
- User frustration with a repeated issue

Distill to: **What went wrong?** and **Why did it happen?**

## Step 2: Rank Prevention Mechanisms

Evaluate each mechanism from **most to least deterministic**. Pick the highest-ranked one that fits:

| Rank | Mechanism | Determinism | When to Use | File |
|------|-----------|-------------|-------------|------|
| 1 | **PreToolUse hook** | Blocks the action | Prevents the mistake from being committed/pushed/executed | `.claude/settings.json` |
| 2 | **ESLint rule** | Fails CI + agent self-corrects | Code pattern catchable by AST analysis | ESLint config |
| 3 | **Agent rule** (error) | Blocks commit via lint-gate | Text/regex pattern in source code | `.claude/config/agent-rules.json` |
| 4 | **Agent rule** (warn) | Warns at commit, agent sees it | Pattern worth flagging but not blocking | `.claude/config/agent-rules.json` |
| 5 | **Review checklist item** | Caught during /review | Requires contextual judgment, not regex | `.claude/skills/review/checklist.md` |
| 6 | **CLAUDE.md convention** | Read at session start | Behavioral guidance, conventions, gotchas | `CLAUDE.md` or workspace CLAUDE.md |
| 7 | **Memory** | Recalled in future sessions | User preference, project context, non-obvious insight | `~/.claude/projects/.../memory/` |

**Decision criteria:**
- Can a regex catch it? → Agent rule (rank 3-4)
- Can ESLint's AST catch it? → ESLint rule (rank 2)
- Should it block an action entirely? → Hook (rank 1)
- Does it require reading surrounding code? → Checklist item (rank 5)
- Is it a convention or "how we do things"? → CLAUDE.md (rank 6)
- Is it specific to this user/project context? → Memory (rank 7)

**Prefer combining mechanisms** when the problem is serious:
- Agent rule (catch it early) + Checklist item (catch it in review) = defense in depth
- CLAUDE.md convention + Agent rule = guidance + enforcement

## Step 3: Present the Plan

Before implementing, show the user:

```
Problem: [what went wrong]
Root cause: [why it happened]
Prevention: [mechanism chosen] — [why this rank]
  Determinism rank: [1-7, where 1 = most deterministic]
  Implementation: [what specifically will be added]
  Alternative: [next-best mechanism if this one doesn't fit]
```

Ask: "Implement this? Or prefer a different approach?"

## Step 4: Implement

Based on the chosen mechanism:

### Hook (rank 1)
1. Write the hook script to `.claude/scripts/hooks/`
2. Register in `.claude/settings.json` (use repo-relative paths)
3. Syntax-check: `node -c <script>`

### ESLint rule (rank 2)
1. Find the appropriate built-in or plugin rule
2. Add to the project's ESLint config
3. Test: run ESLint with the new rule against the codebase

### Agent rule (rank 3-4)
1. Read `.claude/config/agent-rules.json`
2. Add the rule entry with appropriate severity
3. Test the regex against the codebase to show existing violations
4. Write the updated config

### Review checklist item (rank 5)
1. Read `.claude/skills/review/checklist.md`
2. Add the item to the appropriate Pass 1 or Pass 2 category
3. Write the updated checklist

### CLAUDE.md convention (rank 6)
1. Determine the right CLAUDE.md (root or workspace-level)
2. Find the appropriate section (Conventions, Gotchas, etc.)
3. Add the entry — concise, with the "why" included

### Memory (rank 7)
1. Write to the appropriate memory type (feedback, project, user)
2. Update MEMORY.md index

## Step 5: Verify

After implementing, verify the prevention works:

- **Hook:** Simulate the blocked action and confirm it's caught
- **ESLint/Agent rule:** Grep for existing violations, confirm the pattern matches
- **Checklist:** Read the checklist and confirm the item is clear and actionable
- **CLAUDE.md:** Read the section and confirm it's findable and unambiguous

## Step 6: Create Issue (if not instant-fixable)

If the prevention requires broader changes (refactoring existing code to comply, updating multiple files, etc.), create a GitHub issue:

```bash
gh issue create --title "Enforce: <prevention description>" --label "<label>" --body "$(cat <<'EOF'
## Problem
<what went wrong, with context>

## Prevention Implemented
- [x] <mechanism>: <what was added>

## Remaining Work
- [ ] <any cleanup needed for existing violations>
- [ ] <any follow-up changes>

## Source
Identified during: <PR or session context>
EOF
)"
```

## Step 7: Report

```
Prevention installed:
  Mechanism: [type] (rank: [1-7, 1 = most deterministic])
  File: [path]
  What it catches: [description]
  Existing violations: [count, if applicable]
  Issue: #NNN (if created)
```

## Gotchas

- **Don't over-engineer prevention.** A CLAUDE.md line is better than a complex hook for something that happens once a year.
- **Hook commands in `.claude/settings.json` must use repo-relative paths** — never absolute paths.
- **Test regex patterns** before committing them. A bad regex silently disables the rule.
- **Review checklist items need file:line specificity guidance.** Don't add vague items like "check for bugs."
- **Multiple mechanisms are OK** for serious issues. Defense in depth > single point of prevention.
- **If the problem is "Claude did X wrong"**, the fix is usually CLAUDE.md guidance or memory, not a lint rule.
