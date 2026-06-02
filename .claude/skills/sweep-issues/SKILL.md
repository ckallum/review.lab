---
_origin: calsuite@b196ace
name: sweep-issues
version: 1.0.0
description: |
  Sweep the current session for deferred items, fast-follows, enhancements,
  minor bugs, and improvements — then auto-create GitHub issues for each.
  Runs automatically at the end of /ship, after plans, or manually.
user-invocable: true
argument-hint: "[--dry-run]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

# Sweep Issues: Auto-Create GitHub Issues from Session Work

You are running `/sweep-issues`. Scan the current conversation and recent changes for items that should be tracked as GitHub issues.

## Arguments

- `/sweep-issues` — create issues (default)
- `/sweep-issues --dry-run` — list what would be created, but don't create anything

## What to Capture

Scan the conversation for ANY of these patterns:

1. **Deferred items** — "we'll do this later", "out of scope for this PR", "deferred to a follow-up", "not in V1", "TODO:", "FIXME:", "HACK:"
2. **Fast-follows** — "next step would be", "follow-up PR for", "should also add", "nice to have"
3. **Enhancements** — "could be improved by", "future enhancement", "would be nice to", "stretch goal"
4. **Minor bugs** — "noticed that X doesn't work when", "edge case:", "workaround:"
5. **Technical debt** — "this is hacky", "should refactor", "temporary solution", "tech debt"
6. **Decisions** — "decided not to X because Y" (create issue to revisit if context changes)
7. **Items from review** — code review findings marked as non-blocking or informational

## What NOT to Capture

- Items that already have a GitHub issue (check with `gh issue list --search "keyword" --limit 5`)
- Items completed in this session
- Items that are trivially small (single-line fixes you could do right now)
- Vague wishes without actionable scope
- **Bugs in code this branch is currently touching** — these belong inline in the PR, not deferred. Step 2c detects and surfaces these explicitly.

## Process

### Step 1: Gather Candidates

Review the conversation history and identify candidate items. For each, note:
- **What**: one-line description
- **Why**: context from the conversation
- **Source**: what triggered it (review finding, user comment, edge case discovered, etc.)
- **Category**: `enhancement` | `bug` | `tech-debt` | `infrastructure`
- **Mode**: `AFK` | `HITL` — see `/guardian`'s "How AFK/HITL composes across skills" section for authoritative definitions and how this label cascades into `/execute` runtime behavior and `/guardian` permission modes. For classification at this layer:
  - **AFK** — clearly-specified implementation, no design decisions or external access required.
  - **HITL** — needs a design decision, manual verification, external access, or domain knowledge an agent can't get from the code.
  - Prefer AFK whenever possible — only mark HITL when there's a real reason an agent can't finish unattended.

### Step 2: Filter — dedup, prior rejections, and PR-introduced bugs

For each candidate:

**2a. Search existing GitHub issues:**
```bash
gh issue list --search "<keywords>" --limit 5
```
Skip anything that's already tracked. If an existing issue is related but doesn't cover the new scope, note it as a cross-reference.

**2b. Check `.out-of-scope/` for prior rejections.** If `.out-of-scope/` exists at the repo root, grep it for keyword matches against the candidate:
```bash
[ -d .out-of-scope ] && grep -rli "<keyword>" .out-of-scope/ 2>/dev/null
```
If a prior rejection covers the same idea, **skip the candidate silently** and note it in the report as `Skipped (out-of-scope: <slug>.md)`. Don't re-litigate decisions that were already made — that's the whole point of the knowledge base.

If a prior rejection is *related but not the same scope*, surface it to the user: *"This is similar to a previous rejection (`.out-of-scope/<slug>.md`) but the new scope differs because X — proceed?"* The user decides whether the new scope warrants a new issue or whether to update the rejection record.

**2c. Flag PR-introduced bugs.** A bug in code this branch is already changing belongs inline in the PR, not in a deferred issue. Skip this check on `main` or when no diff exists — otherwise it produces noise.

```bash
# Skip the check entirely if not on a feature branch with real divergence
branch=$(git branch --show-current 2>/dev/null)
if [ -n "$branch" ] && [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
  # Resolve the repo's default branch instead of assuming origin/main — repos
  # whose default is master (or anything else) would otherwise diff against a
  # nonexistent ref and silently no-op this guard.
  base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
  changed_files=$(git diff "$base" --name-only 2>/dev/null)
fi
```

If `$changed_files` is non-empty, for every candidate categorized as `bug`:

1. Match the candidate against the diff. A candidate is **PR-touched** if any of:
   - Its description references a file path in `$changed_files` (literal or basename match)
   - Its description references a symbol (function, type, constant) that appears in `git diff "$base"` (the default-branch diff resolved above) as an added or modified line
2. If PR-touched, use AskUserQuestion individually:
   ```text
   This bug looks like it lives in code this PR is changing:
     <one-line bug description>
     Matched: <file path or symbol>

   PR-introduced bugs should be fixed in this PR, not deferred.

   A) Fix inline — skip this candidate. You'll fix it before the PR is published
      (or as a follow-up commit if the PR is already up).
   B) Defer to issue — confirmed pre-existing, not introduced by this branch.
   C) Dismiss — not a real bug.
   ```
3. Apply the answer:
   - **A:** drop from the create-list. Add to the final report as `Skipped (fix inline): <description>`. After Step 5, surface a clear callout reminding the user to fix before publishing.
   - **B:** keep the candidate. Add a `**Pre-existing:** confirmed not introduced by branch <name>` line to the issue body so the next reader knows the triage already happened.
   - **C:** drop silently.

This guard runs on every `/sweep-issues` invocation, including the safety-net call at the end of `/ship`. It's the last line of defense against PR-introduced bugs slipping into deferred issues.

### Step 3: Present Candidates

Show the user a numbered list:
```
Found N items to create as GitHub issues:

1. [enhancement] Short title — one-line context
2. [tech-debt] Short title — one-line context
3. [bug] Short title — one-line context
```

If `--dry-run`, stop here.

### Step 4: Create Issues

For each item, create a GitHub issue with **both labels** — one category label (from the mapping below) and one mode label (`afk` or `hitl`):

```bash
gh issue create --title "<title>" \
  --label "<category-label>" \
  --label "<mode-label>" \
  --body "$(cat <<'EOF'
## Summary
{1-2 sentence description}

## Source
- Identified during: {PR title / plan name / session context}
- Related: {any related issues or PRs}

## Requirements
- [ ] {requirement 1}
- [ ] {requirement 2}
- [ ] {requirement 3}
EOF
)"
```

`<category-label>` is one of `enhancement` / `bug` / `tech-debt` / `infrastructure`. `<mode-label>` is one of `afk` / `hitl`. Both labels are required — never omit the mode label.

**Label mapping:**
- `enhancement` → `enhancement`
- `bug` → `bug`
- `tech-debt` → `tech-debt`
- `infrastructure` → `infrastructure`

**Mode label** (additional, applied alongside category):
- `AFK` → `afk` label
- `HITL` → `hitl` label

If the labels don't already exist on the repo, create them once. This covers **both** the mode labels (`afk`/`hitl`) and the custom category labels (`tech-debt`/`infrastructure`) — `gh issue create --label tech-debt` fails outright if the label is missing, which would silently drop the issue. (`enhancement` and `bug` ship as defaults on every GitHub repo, so they don't need bootstrapping.) **Gate each create call** — `gh label create` errors on existing labels without `--force`, and `--force` would overwrite color/description on every run. Use:

```bash
gh label list --json name -q '.[].name' | grep -qx afk \
  || gh label create afk --color 0E8A16 --description "Agent can complete unattended"
gh label list --json name -q '.[].name' | grep -qx hitl \
  || gh label create hitl --color FBCA04 --description "Needs human in the loop"
gh label list --json name -q '.[].name' | grep -qx tech-debt \
  || gh label create tech-debt --color D4C5F9 --description "Technical debt"
gh label list --json name -q '.[].name' | grep -qx infrastructure \
  || gh label create infrastructure --color C5DEF5 --description "Infrastructure / tooling"
``` The labels let `/execute --multi issue:...` filter for AFK-only work safe to fan out across panes, and let `/babysit-pr` flag HITL items that need user attention.

### Step 5: Report

Output a summary:
```
Created N issues:
- #123 Title
- #124 Title
- #125 Title

Skipped M items (already tracked or too small).
```

## Recording rejections to `.out-of-scope/`

When the user says *"don't create that"*, *"we considered this and rejected it"*, or closes an enhancement as `wontfix`, **write a rejection record** to `.out-of-scope/<kebab-slug>.md`. Future `/sweep-issues` runs (and `/plan --grill`, `/improve-architecture`) read this directory to avoid re-suggesting the same thing.

Format:

```markdown
---
slug: <kebab-slug>
rejected: YYYY-MM-DD
related-issues: ["#NN", "#MM"]   # optional — quote each ID; bare # starts a YAML comment
---

# <Short title>

**The proposal:** {1-2 sentences describing what was suggested.}

**Why we rejected it:** {The load-bearing reason. This is the most important field — it must be specific enough that a future explorer reading this 6 months later understands why and doesn't re-suggest.}

**What would change our minds:** {A concrete trigger that should reopen this. Examples: "if we ever add multi-tenancy", "if a customer asks for it more than 3 times", "if we hit N% error rate on the alternative". If nothing would change our minds, write "nothing — this is a permanent no" and explain why.}
```

Skip ephemeral reasons ("not worth it right now") — those become stale fast. Only record rejections with **durable** reasons, the kind that would still apply in 6 months.

## Important Rules

- **Never create duplicate issues.** Always search GitHub *and* `.out-of-scope/` first.
- **Never include secrets, credentials, API keys, or tokens in issue bodies.** Redact any sensitive data from conversation context before creating issues.
- **Keep issues small and focused.** One issue per concern. Don't bundle unrelated items.
- **Include enough context** that someone reading the issue 3 months from now understands what and why.
- **Don't over-specify requirements.** 3-5 checklist items is ideal. The implementer will spec the details.
- **Link related issues** when they exist (use `Related: #NNN` in the body).
- **Tag mode (AFK / HITL).** Every created issue must carry exactly one of the `afk` or `hitl` labels.
- **Record rejections, don't lose them.** When the user vetoes a candidate or closes an enhancement as `wontfix`, write `.out-of-scope/<slug>.md` so the rejection survives across sessions.
