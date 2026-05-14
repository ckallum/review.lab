---
_origin: calsuite@2a7c883
name: babysit-pr
version: 1.0.0
description: |
  watch this PR, monitor CI, babysit, watch CI, is CI done, check PR status,
  watch for merge, keep an eye on this.
  Monitor a PR through to merge. Polls CI (ETag-based, zero rate-limit cost),
  retries flaky failures once, notifies when checks pass, detects merge conflicts.
  Auto-spawned after `gh pr create` or invoke manually.
argument-hint: [<pr-number>] [--status] [--stop] [--logs]
allowed-tools:
  - Bash
  - Read
---

# /babysit-pr: PR Babysitter

Monitors a PR from creation to merge. Runs autonomously in the background — you only hear from it when something needs your attention.

## Setup

On first run, check for `.claude/skills/babysit-pr/config.json`. If missing, ask the user with AskUserQuestion:

1. **Notification style** — "How do you want to be notified?"
   - A) macOS native notifications (recommended)
   - B) Terminal bell only
   - C) Silent (status file only)

Save to `.claude/skills/babysit-pr/config.json`:
```json
{
  "notification": "macos"
}
```

On subsequent runs, load the config silently.

## What it does (automatically)

1. **Polls CI checks** — ETag-based conditional requests (304 = zero API cost)
2. **Retries flaky CI** — reruns failed workflow runs once via `gh run rerun --failed`
3. **Notifies when ready** — sends macOS notification when all checks pass (merge is always human)
4. **Detects merge conflicts** — notifies you if the PR becomes unmergeable
5. **Monitors until merged** — sends macOS notification when PR lands, then exits

## Notifications

- macOS native notifications via `osascript`
- Status file: `/tmp/claude-babysit-<pr>.json`
- Log file: `/tmp/claude-babysit-<pr>.log`

## Usage

### Auto-triggered (no action needed)
The PostToolUse hook on `gh pr create` automatically spawns the daemon. You don't need to do anything.

### Manual invocation

**Check status of a babysitter:**
```bash
/babysit-pr 123 --status
# or just
/babysit-pr --status
```

**Start babysitting an existing PR:**
```bash
/babysit-pr 123
```

**View logs:**
```bash
/babysit-pr 123 --logs
```

**Stop a running babysitter:**
```bash
/babysit-pr 123 --stop
```

---

## Workflow

### If `$ARGUMENTS` contains `--status` (or no PR number given)

Show status of all active babysitters:

```bash
ls /tmp/claude-babysit-*.json 2>/dev/null
```

For each status file, read and display:
- PR number and URL
- Current state (watching, ready, retrying, merged, conflict, checks-failed, error)
- Detail message
- Last updated timestamp

If no status files found, say "No active babysitters."

### If `$ARGUMENTS` contains `--logs`

Read and display the log file:
```bash
cat /tmp/claude-babysit-<pr>.log
```

### If `$ARGUMENTS` contains `--stop`

Read the PID from the status file and kill it:
```bash
# Read PID from status file
cat /tmp/claude-babysit-<pr>.json | jq '.pid'

# Verify it's actually the daemon before killing
ps -p <pid> -o command= | grep babysit-pr-daemon

# Kill it
kill <pid>

# Clean up
rm /tmp/claude-babysit-<pr>.json /tmp/claude-babysit-<pr>.log 2>/dev/null
```

### If a PR number is given (no flags)

1. Check if a babysitter is already running for this PR (status file exists and state is not terminal).
2. If already running, show current status.
3. If not running, determine `owner/repo` from the current git remote:
   ```bash
   gh repo view --json nameWithOwner --jq '.nameWithOwner'
   ```
4. Spawn the daemon:
   ```bash
   node .claude/scripts/hooks/babysit-pr-daemon.js <owner/repo> <pr-number> &
   disown
   ```
5. Confirm: "Babysitter started for PR #<n>. You'll get a notification when something needs attention."

---

## States

| State | Meaning | Action |
|-------|---------|--------|
| `watching` | Polling CI checks | None — daemon is working |
| `retrying` | Flaky CI detected, rerunning | None — daemon is retrying |
| `ready` | All CI green | **You can merge the PR** |
| `merged` | PR merged! | Done — daemon has exited |
| `conflict` | Merge conflicts detected | **You need to resolve conflicts** |
| `checks-failed` | CI failed after retry | **You need to fix the failure** |
| `timeout` | Daemon hit 60-min limit | Re-run `/babysit-pr <n>` to restart |
| `error` | Something went wrong | Check logs with `/babysit-pr <n> --logs` |

## Important Rules

1. **Never block the user.** The daemon runs in the background. The skill only reads status.
2. **Notifications are for action items only.** Don't notify on routine state changes.
3. **One retry per push.** Don't retry more than once — persistent failures need human attention.
4. **Keep watching after conflicts/failures.** The user might push a fix — don't exit prematurely.

## Gotchas

- **Daemon writes to `/tmp/`** which is cleared on reboot. Status and logs will be lost after a restart.
- **Max 1 retry per push.** Persistent CI failures need human attention — don't loop.
- **Merging is always human.** The daemon never merges, even if auto-merge is enabled on the repo. It only notifies.
- **ETag polling requires `gh` auth.** If `gh auth status` fails, the daemon will error out immediately.
- **Multiple babysitters for the same PR** can conflict. The skill checks for existing status files before spawning.
