---
_origin: calsuite@2a7c883
name: retro
version: 1.1.0
description: |
  retro, retrospective, what did I ship, weekly summary, how was my week,
  shipping velocity, commit stats, engineering metrics.
  Weekly engineering retrospective with commit history, work patterns,
  code quality metrics, persistent history, and trend tracking.
argument-hint: [window] [compare]
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Agent
---

# /retro — Weekly Engineering Retrospective

Generates a comprehensive engineering retrospective analyzing commit history, work patterns, and code quality metrics.

## Arguments
- `/retro` — default: last 7 days
- `/retro 24h` — last 24 hours
- `/retro 14d` — last 14 days
- `/retro 30d` — last 30 days
- `/retro compare` — compare current window vs prior same-length window
- `/retro compare 14d` — compare with explicit window

## Setup

On first run, check for `.claude/skills/retro/config.json`. If missing, ask the user with AskUserQuestion:

1. **Author email** — default from `git config user.email`. "Is this the correct email for your commits?"
   - A) Use `<detected-email>` (recommended)
   - B) Use a different email: `<input>`

2. **Default window** — "What's your preferred retro window?"
   - A) 7 days (recommended — weekly retro)
   - B) 14 days
   - C) 30 days

Save to `.claude/skills/retro/config.json`:
```json
{
  "author_email": "user@example.com",
  "default_window": "7d"
}
```

On subsequent runs, load the config silently. The user can override via arguments — config is just the default.

## Instructions

Parse the argument to determine the time window. Default to 7 days if no argument given. Use `--since="N days ago"`, `--since="N hours ago"`, or `--since="N weeks ago"` for git log queries.

**Argument validation:** If the argument doesn't match a number followed by `d`, `h`, or `w`, the word `compare`, or `compare` followed by a number and `d`/`h`/`w`, show usage and stop:
```
Usage: /retro [window]
  /retro              — last 7 days (default)
  /retro 24h          — last 24 hours
  /retro 14d          — last 14 days
  /retro 30d          — last 30 days
  /retro compare      — compare this period vs prior period
  /retro compare 14d  — compare with explicit window
```

### Step 1: Gather Raw Data — PARALLEL AGENTS

First, fetch origin and resolve the retrospective subject. For a personal retro (default), scope all queries to the current user:

```bash
git fetch origin main --quiet
RETRO_AUTHOR="$(git config user.email)"
```

If `.claude/skills/retro/config.json` exists and sets `author_email`, it overrides `git config user.email` — load the config value into `RETRO_AUTHOR` instead.

Then dispatch **3 parallel agents** in a single message to gather data concurrently. Pass the author email to each agent.

**Agent 1 — Commit metrics + LOC breakdown:**
```
prompt: "Gather git commit metrics for the retro. Run these commands and return ALL raw output:

1. git log origin/main --author='<RETRO_AUTHOR>' --since='<window>' --format='%H|%ai|%s' --shortstat
2. git log origin/main --author='<RETRO_AUTHOR>' --since='<window>' --format='COMMIT:%H' --numstat
3. git log origin/main --author='<RETRO_AUTHOR>' --since='<window>' --format='%s' | grep -oE '#[0-9]+' | sed 's/^#//' | sort -n | uniq | sed 's/^/#/'

Return the raw output of all three commands, clearly labeled."
description: "Commit metrics"
```

**Agent 2 — Time patterns + sessions + streak:**
```
prompt: "Gather git timing data for the retro. Run these commands and return ALL raw output:

1. git log origin/main --author='<RETRO_AUTHOR>' --since='<window>' --format='%at|%ai|%s' | sort -n
2. git log origin/main --author='<RETRO_AUTHOR>' --format='%ad' --date=format:'%Y-%m-%d' | sort -u

For the streak calculation: count consecutive days backward from today that have at least one commit by this author. Return the raw output and the streak count."
description: "Time patterns + streak"
```

**Agent 3 — Hotspots + history:**
```
prompt: "Gather file hotspot data and retro history. Run these commands:

1. git log origin/main --author='<RETRO_AUTHOR>' --since='<window>' --format='' --name-only | grep -v '^$' | sort | uniq -c | sort -rn | head -20
2. ls -t .context/retros/*.json 2>/dev/null | head -1

If a prior retro JSON exists, read it and return the contents. Return all raw output."
description: "Hotspots + history"
```

Wait for all 3 agents. Collect their raw output, then proceed to compute metrics from the combined data.

### Step 2: Compute Metrics

Calculate and present in a summary table:

| Metric | Value |
|--------|-------|
| Commits to main | N |
| PRs merged | N |
| Total insertions | N |
| Total deletions | N |
| Net LOC added | N |
| Test LOC (insertions) | N |
| Test LOC ratio | N% |
| Active days | N |
| Detected sessions | N |
| Avg LOC/session-hour | N |

Test files are identified by matching: `test/`, `spec/`, `__tests__/`, `.test.ts`, `.test.tsx`, `.spec.ts`, `.test.js`, `.test.jsx`, `.spec.js`, `e2e/`, `_test.go`, `_test.py`, `test_*.py`.

### Step 3: Commit Time Distribution

Show hourly histogram using bar chart:

```
Hour  Commits  ████████████████
 00:    4      ████
 07:    5      █████
 ...
```

Identify and call out:
- Peak hours
- Dead zones
- Whether pattern is bimodal (morning/evening) or continuous
- Late-night coding clusters (after 10pm)

### Step 4: Work Session Detection

Detect sessions using **45-minute gap** threshold between consecutive commits. For each session:
- Start/end time
- Number of commits
- Duration in minutes

Classify sessions:
- **Deep sessions** (50+ min)
- **Medium sessions** (20-50 min)
- **Micro sessions** (<20 min)

Calculate:
- Total active coding time
- Average session length
- LOC per hour of active time

### Step 5: Commit Type Breakdown

Categorize by conventional commit prefix (feat/fix/refactor/test/chore/docs). Show as percentage bar:

```
feat:     20  (40%)  ████████████████████
fix:      27  (54%)  ███████████████████████████
refactor:  2  ( 4%)  ██
```

Flag if fix ratio exceeds 50% — signals "ship fast, fix fast" pattern.

### Step 6: Hotspot Analysis

Show top 10 most-changed files. Flag:
- Files changed 5+ times (churn hotspots)
- Test files vs production files in the hotspot list
- Schema files that change frequently (migration churn)

### Step 7: PR Size Distribution

From commit diffs, estimate PR sizes:
- **Small** (<100 LOC)
- **Medium** (100-500 LOC)
- **Large** (500-1500 LOC)
- **XL** (1500+ LOC) — flag these

### Step 8: Focus Score + Ship of the Week

**Focus score:** Percentage of commits touching the single most-changed top-level directory. Higher = deeper focus. Report as: "Focus score: 62% (src/app/)"

**Ship of the week:** Auto-identify the single highest-LOC PR. Highlight PR number, title, LOC changed, and why it matters.

### Step 9: Week-over-Week Trends (if window >= 14d)

If time window is 14+ days, split into weekly buckets and show:
- Commits per week
- LOC per week
- Test ratio per week
- Fix ratio per week

### Step 10: Streak Tracking

Count consecutive days with at least 1 commit to origin/main:

```bash
git log origin/main --author="$RETRO_AUTHOR" --format="%ad" --date=format:"%Y-%m-%d" | sort -u
```

Count backward from today. Display: "Shipping streak: 47 consecutive days"

### Step 11: Load History & Compare

Before saving, check for prior retro history:

```bash
ls -t .context/retros/*.json 2>/dev/null
```

**If prior retros exist:** Load the most recent one. Show a **Trends vs Last Retro** section:
```
                    Last        Now         Delta
Test ratio:         22%    →    41%         ↑19pp
Sessions:           10     →    14          ↑4
LOC/hour:           200    →    350         ↑75%
Fix ratio:          54%    →    30%         ↓24pp (improving)
```

**If no prior retros:** Skip comparison. Append: "First retro recorded — run again next week to see trends."

### Step 12: Save Retro History

```bash
mkdir -p .context/retros
```

Save JSON snapshot with this schema:
```json
{
  "date": "2026-03-12",
  "window": "7d",
  "metrics": {
    "commits": 47,
    "prs_merged": 12,
    "insertions": 3200,
    "deletions": 800,
    "net_loc": 2400,
    "test_loc": 1300,
    "test_ratio": 0.41,
    "active_days": 6,
    "sessions": 14,
    "deep_sessions": 5,
    "avg_session_minutes": 42,
    "loc_per_session_hour": 350,
    "feat_pct": 0.40,
    "fix_pct": 0.30,
    "peak_hour": 22
  },
  "streak_days": 47,
  "tweetable": "Week of Mar 8: 47 commits, 3.2k LOC, 38% tests, 12 PRs, peak: 10pm"
}
```

### Step 13: Skill Usage Telemetry

Read `~/.claude/analytics/skill-usage.jsonl` (written by `skill-usage-tracker.cjs`). Filter entries by timestamp within the retro window. Skip this step silently if the file doesn't exist — skill-usage telemetry is an additive signal, not a dependency.

Compute:
- **Top skills by invocation count** (top 5)
- **Skills invoked but session was abandoned mid-flow** — heuristic: a skill invocation followed by no commits in the next 2 hours on the same session
- **Skills declared in profile but never invoked in window** — cross-reference against `config/profiles.json` for the current profile
- **Heavy-use candidates for cron/scheduling** — any skill invoked 5+ times in the window

Output a short section:
```
### Skill Usage
Top 5: /ship (12), /review (8), /debug (5), /plan (4), /context7 (3)
Heavy use → consider automating: /babysit-pr (7× — run via /loop?)
Never used in window: /plan-ceo, /retro — keep or drop from profile?
```

### Step 14: Learning Loop (opt-in)

For each item in **3 Things to Improve** (Step 13's narrative), propose one concrete rule update to the most likely-responsible skill file. Format:

```
### Proposed Skill Updates
- Improve: "XL PRs slipped through unsplit"
  → Edit skills/ship/SKILL.md Step 6: add hard rule — abort if diff > 1500 LOC without explicit override.
- Improve: "Fix-ratio 60% on auth module"
  → Edit skills/review/SKILL.md: add auth-module checklist (regression tests required).
```

Do **not** apply the edits automatically. Print the proposals and ask (AskUserQuestion) whether to apply each one. Learning loop is opt-in — this is where the skills self-improve from lived evidence.

### Step 15: Write the Narrative

**Tweetable summary** (first line):
```
Week of Mar 8: 47 commits, 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d
```

## Engineering Retro: [date range]

### Summary Table
(from Step 2)

### Trends vs Last Retro
(from Step 11 — skip if first retro)

### Time & Session Patterns
(from Steps 3-4)
- When the most productive hours are
- Whether sessions are getting longer or shorter
- Estimated hours per day of active coding

### Shipping Velocity
(from Steps 5-7)
- Commit type mix
- PR size discipline
- Fix-chain detection

### Code Quality Signals
- Test LOC ratio trend
- Hotspot analysis
- Any XL PRs that should have been split

### Focus & Highlights
(from Step 8)
- Focus score with interpretation
- Ship of the week callout

### Top 3 Wins
3 highest-impact things shipped. For each: what, why it matters, what's impressive.

### 3 Things to Improve
Specific, actionable, anchored in actual commits.

### 3 Habits for Next Week
Small, practical, realistic. Each takes <5 minutes to adopt.

### Week-over-Week Trends
(if applicable, from Step 9)

### Skill Usage
(from Step 13 — omit if telemetry file missing)

### Proposed Skill Updates
(from Step 14 — opt-in)

---

## Compare Mode

When `/retro compare` (or `/retro compare 14d`):

1. Compute metrics for the current parsed window using `--since="<window>"`
2. Compute metrics for prior same-length window using both `--since` and `--until` to avoid overlap
3. Show side-by-side comparison table with deltas and arrows
4. Write brief narrative on biggest improvements and regressions
5. Save only current-window snapshot

## Tone

- Encouraging but candid, no coddling
- Specific and concrete — anchor in actual commits
- Skip generic praise — say exactly what was good and why
- Frame improvements as leveling up, not criticism
- Keep total output around 2500-3500 words
- Use markdown tables and code blocks for data, prose for narrative
- Output directly to conversation — do NOT write to filesystem (except JSON snapshot)

## Important Rules

- ALL narrative output goes to conversation. Only file written is JSON snapshot.
- Use `origin/main` for all git queries (not local main)
- If zero commits in window, say so and suggest a different window
- Round LOC/hour to nearest 50
- Do not read CLAUDE.md — this skill is self-contained
- On first run, skip comparison sections gracefully

## Gotchas

- **All git queries must be scoped by `--author`.** Without it, you'll include other contributors' commits in a personal retro.
- **Compare mode uses the parsed window, not hardcoded 7 days.** If the user says `/retro compare 14d`, the prior window is also 14 days, using `--since` and `--until` to avoid overlap.
- **Streak calculation counts backward from today.** A gap of even one day resets the streak to 0 (or to the count since the gap).
- **`origin/main` must be fetched first.** The skill runs `git fetch origin main --quiet` at the start — if this fails (no remote, no auth), all queries will use stale data.
