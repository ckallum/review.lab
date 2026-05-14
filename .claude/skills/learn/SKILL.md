---
_origin: calsuite@2a7c883
name: learn
version: 1.0.0
description: |
  save learning, remember this, note this pattern, record pitfall, capture preference,
  learn from this, review learnings, what have I learned, search learnings, prune learnings.
  Manage durable, project-specific learnings across sessions — patterns, pitfalls,
  preferences. Learnings compound across sessions so Claude gets smarter on your
  codebase over time.
argument-hint: [save | list | search <query> | prune | export]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# /learn — Cross-Session Learnings

Durable memory for *this project*. Unlike `memory/` (which is about the user), `.context/learnings/` is about the *codebase* — patterns that worked, pitfalls encountered, preferences confirmed. Claude reads these at session start (via `/session-start`) and appends to them whenever something non-obvious surfaces.

## Learnings vs ADRs vs CONTEXT.md

Three sibling artifacts, three different purposes — pick the right one before saving:

| Artifact | Scope | When |
|---|---|---|
| **Learning** (`.context/learnings/<slug>.md`) | Project-specific patterns, pitfalls, preferences | Non-obvious fact you want next session to remember |
| **CONTEXT.md term** | Domain vocabulary | A new domain term was resolved or sharpened during the conversation |
| **ADR** (`docs/adr/NNNN-*.md`) | Architectural decisions that are hard to reverse | A real trade-off was made and a future reader will wonder "why" |

If the candidate is a domain term, recommend updating `CONTEXT.md` (the project's domain glossary) instead of saving a learning — `/plan` and `/improve-architecture` carry the format inline. In a multi-context repo the term goes in the relevant `<context>/CONTEXT.md`, not the root.

If it's an architectural decision that meets **all three** ADR criteria — hard to reverse, surprising without context, result of a real trade-off — recommend writing an ADR. Path depends on scope:

- **System-wide decision** → `docs/adr/NNNN-kebab-title.md` at the repo root.
- **Context-specific decision** (multi-context repos only) → `<context>/docs/adr/NNNN-kebab-title.md`, alongside that context's code.

Filename convention is the same in both locations: zero-padded sequential `NNNN`, verb-led kebab title. ADRs commit to the repo and survive across teams in a way learnings don't.

Learnings are for everything else: smaller-scale durable facts that don't merit either.

## Storage

Per-project: `.context/learnings/` (in the current repo, gitignored or committed — user choice).

Each learning is one file: `.context/learnings/<kebab-slug>.md`

```markdown
---
id: <kebab-slug>
type: pattern | pitfall | preference
tags: [tag1, tag2]
created: 2026-04-15
last_seen: 2026-04-15
hits: 1
---

# <Title>

**Context:** when this applies.
**Rule:** what to do / avoid.
**Why:** evidence — incident, PR link, commit SHA, conversation quote.
```

An index file `.context/learnings/INDEX.md` lists all learnings, one line each: `- [title](slug.md) — type — one-line hook`. Keep under 200 lines; older items get pruned.

## Arguments

- `/learn save` — capture a learning from the current conversation (default when argument looks like a statement)
- `/learn list` — show the index, grouped by type
- `/learn search <query>` — grep across learnings
- `/learn prune` — find stale learnings (no `last_seen` hit in 90+ days, or contradicted by current code)
- `/learn export` — concat all learnings to stdout for piping

If no argument is given, default to `save` using the most recent non-obvious fact from the conversation.

---

## save mode

**Goal:** capture one durable fact that will be useful in *future* sessions.

### Step 1: Identify the learning

Scan the current conversation for the most recent exchange where:
- The user corrected a mistaken assumption, OR
- A non-obvious fact about this codebase surfaced (invariant, constraint, historical decision), OR
- The user confirmed a non-default approach ("yes, exactly that")

If nothing qualifies, say "Nothing worth saving surfaced. Skipping." and stop.

### Step 2: Classify

- **pattern** — a positive rule ("always do X in situation Y")
- **pitfall** — a negative rule ("don't do X — it breaks Y")
- **preference** — a project-specific taste call confirmed by the user

### Step 3: Check for duplicates

```bash
ls .context/learnings/*.md 2>/dev/null
```

Grep titles and tags for overlap. If a similar learning exists, **update it** (bump `hits`, update `last_seen`, append context) rather than creating a new one.

### Step 4: Write the file

Pick a kebab-slug from the title. Write with the frontmatter template above. Keep the body under 12 lines — learnings are reference cards, not essays.

### Step 5: Update the index

Append one line to `.context/learnings/INDEX.md`:
```
- [title](slug.md) — pitfall — one-line hook
```

If INDEX.md doesn't exist, create it with a header:
```markdown
# Project Learnings

Cross-session durable facts about this codebase. Read at session start.

```

### Step 6: Confirm

Output a 2-line confirmation: what was saved + file path.

---

## list mode

Read `.context/learnings/INDEX.md`. Print grouped by type (patterns, pitfalls, preferences). If empty, print "No learnings recorded yet. Use `/learn save` after a non-obvious fact surfaces."

## search mode

`grep -l -i "<query>"` across `.context/learnings/*.md`. For each match, print the title and the first matching line with context.

## prune mode

For each learning file:
1. Check `last_seen` — if older than 90 days, flag as stale.
2. For learnings referencing specific files/functions/flags, verify they still exist (`grep` / `ls`). If not, flag as potentially obsolete.
3. Ask the user (with AskUserQuestion) which flagged items to delete, keep, or refresh.

Update INDEX.md after deletions.

## export mode

`cat .context/learnings/*.md` to stdout. Useful for piping into another tool or a prompt.

---

## When Claude should auto-invoke this

You (Claude) should suggest `/learn save` — not run it silently — whenever:
- The user corrects you on a project-specific fact you'd want to remember next session
- A non-obvious constraint surfaces that isn't already in CLAUDE.md or a learning
- The user confirms a non-default approach with language like "yes exactly that", "keep doing that"

Ask: *"That's worth saving as a learning — run `/learn save`?"* Don't save without confirmation; learnings have lasting weight.

## Gotchas

- **Learnings are per-repo, not global.** User-level preferences go in memory (`memory/`), not here.
- **INDEX.md is the fast-path.** Keep it tight; full bodies live in the per-learning files.
- **Don't duplicate CLAUDE.md content.** If a rule belongs in CLAUDE.md, put it there instead — CLAUDE.md is always loaded.
- **Evidence matters.** A learning without a `Why:` line is noise. Always anchor to a PR, commit, incident, or user quote.
