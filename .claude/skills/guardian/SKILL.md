---
_origin: calsuite@2a7c883
name: guardian
description: "Configure Guardian autonomous mode, switch modes, view audit log, and manage rules"
user-invocable: true
argument-hint: "[mode|log|rules] [args]"
allowed-tools: Bash(node *), Bash(cat *), Bash(tail *), Bash(jq *), Read, Glob, Edit
---

# /guardian

Manage the Guardian autonomous approval system — switch modes, view audit logs, and edit rules.

## Instructions

Parse `$ARGUMENTS` to determine the subcommand:

### `mode <autonomous|supervised|lockdown>`

Accepted aliases (case-insensitive): `AFK` → `autonomous`, `HITL` → `supervised`. Both `/guardian mode AFK` and `/guardian mode autonomous` resolve to the same canonical value.

Switch Guardian's operating mode:

1. **Normalize the mode argument.** Lowercase the input. If it equals `afk`, rewrite to `autonomous`. If it equals `hitl`, rewrite to `supervised`. Otherwise validate against `{autonomous, supervised, lockdown}` and abort if it doesn't match.
2. Read the project's `.claude/config/guardian-rules.json` (or fall back to the repo's `config/guardian-rules.json`)
3. Update the `"mode"` field to the **normalized canonical** value (never the alias — the on-disk config stores the canonical form so other tooling reads one value, not three).
4. Read the `permissions` object for the new mode
5. Update the project's `.claude/settings.json` — merge the mode's `allow` list into `permissions.allow`
6. Report what changed (include the alias the user typed if it was normalized: *"Switched to `autonomous` (alias `AFK`)."*)

**Modes:**
- **autonomous** (alias: **AFK**) — Broad permissions, guardian blocks only dangerous ops. Best for unattended work — work that can run end-to-end without human input.
- **supervised** (alias: **HITL**) — Read-only tools + safe git. Human-in-the-loop work where the user wants to approve each meaningful action.
- **lockdown** — Minimal read-only access. For auditing or untrusted environments.

**AFK vs HITL is the same axis as autonomous vs supervised.** The aliases exist because `/sweep-issues` (labelling) and `/execute` (running labelled work) use AFK/HITL — those labels map directly onto these modes when an agent picks up the work.

## How AFK / HITL composes across skills

AFK and HITL appear in three skills at three different layers. They compose; they don't contradict.

| Layer | Skill | Question it answers |
|---|---|---|
| **Classification** | `/sweep-issues` | "Does this piece of work need a human in the loop?" Tags issue with `afk` or `hitl` label. |
| **Execution** | `/execute` | "Given a labelled task, how do I run it?" AFK = end-to-end without pausing; HITL = pause at decision points and ask. |
| **Permissions** | `/guardian` | "Which tools are even allowed in the current session?" AFK mode broadens permissions; HITL mode narrows them. |

A typical flow: `/sweep-issues` files an `afk`-labelled issue → `/execute issue <n>` reads the label and runs end-to-end → `/guardian mode autonomous` is the matching permission posture for that run.

**Authoritative definitions live here.** `/sweep-issues` and `/execute` reference this section rather than redefining the terms — when in doubt about how AFK/HITL behaves at a layer not visible from your current skill, read this table.

### `log [N]`

View the Guardian audit log:

1. Find log files at `~/.claude/guardian/logs/*.jsonl`
2. Show the last N entries (default 20), formatted with jq
3. If no logs exist, say so

```bash
tail -n 20 ~/.claude/guardian/logs/$(date +%Y-%m-%d).jsonl | jq .
```

### `rules list`

Display all current deny and warn rules from the guardian config, formatted as a table.

### `rules add <deny|warn> <json>`

Add a new rule to the config. The JSON should include `id`, `tool`, `match`, and `reason` fields.

### `rules remove <rule-id>`

Remove a rule by its ID from either the deny or warn list.

### No arguments / `status`

Show current mode, number of deny/warn rules, and last 5 audit log entries.
