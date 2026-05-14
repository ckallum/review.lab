---
_origin: calsuite@2a7c883
name: customise
description: |
  customise a skill for this project, fork a skill locally, project-specific skill tweak,
  diverge a skill, claim and edit a skill, local skill override, make /ship different here.
  Atomically applies edits and claims the file so future `--sync` never reverts your changes.
  Use when you want to deliberately diverge from calsuite's canonical version of a skill
  for project-specific reasons.
argument-hint: "<skill-name> [free-form instructions]"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Agent
  - AskUserQuestion
---

# Customise a calsuite skill for this project

Diverge a calsuite-managed skill for local project use. This skill fuses "edit the file" and "claim it so sync can't revert" into one atomic action, so you never lose customisations to a later `--sync` because you forgot to claim.

## When to use

- You want this project's `/ship` (or any skill) to behave differently from calsuite's canonical version — e.g., verity's `/ship` has a Lambda deploy step, timeline's `/review` has a stricter accessibility checklist.
- You want divergence to be **deliberate**. Claimed files never receive calsuite updates again.

## When NOT to use

- **One-off fix you want to upstream:** edit the file in calsuite (`$CALSUITE_DIR/skills/<name>/`) instead. `--sync` will flow it to every target. `/customise` intentionally breaks that propagation.
- **Three-way merge with calsuite's evolving version:** that's [#42 `--reconcile`](https://github.com/ckallum/calsuite/issues/42), not yet implemented. Once you claim, you're forked.
- **Propagating your customisation to other targets:** that's [#40 `/reconcile-targets`](https://github.com/ckallum/calsuite/issues/40). Claim per target for now.

## Step 0: Pre-flight — verify calsuite is reachable

Both Step 2 (`configure-claude.js <target>` seed install, if needed) and Step 5 (`configure-claude.js --claim`) invoke calsuite's installer directly. Fail fast with an actionable message if it's not where we expect.

```bash
calsuite_dir="${CALSUITE_DIR:-$HOME/Projects/calsuite}"
if [ ! -f "$calsuite_dir/scripts/configure-claude.js" ]; then
  echo "✗ Calsuite installer not found at $calsuite_dir/scripts/configure-claude.js"
  echo "  Set \$CALSUITE_DIR to your calsuite checkout, or clone it to ~/Projects/calsuite"
  exit 1
fi
```

Hold onto `$calsuite_dir` (the resolved value) for use in Steps 2 and 5 — don't re-resolve each time. If the check fails, abort the whole skill — nothing downstream will work either.

## Step 1: Parse arguments

`$ARGUMENTS` contains: `<skill-name> [optional free-form instructions]`.

- **Skill name:** first word.
- **Instructions (if any):** the remainder of the string.

If no skill name is provided, list the skills in `<cwd>/.claude/skills/` and ask the user to pick one via `AskUserQuestion`:

```
Which skill do you want to customise?
  A) ship
  B) review
  C) debug
  D) ... (populate from .claude/skills/ dirs)
```

## Step 2: Locate the skill file

Resolve the skill's `SKILL.md`:

```bash
skill_path=".claude/skills/<skill-name>/SKILL.md"
```

If the file doesn't exist:

1. Announce: "Skill not yet installed in this target. Running installer first."
2. Run `node "$calsuite_dir/scripts/configure-claude.js" "$(pwd)"` — reuses the `$calsuite_dir` resolved in Step 0.
3. If the file still doesn't exist afterward, abort: the skill name doesn't match any calsuite skill. Suggest running `ls "$calsuite_dir/skills/"` to see available names.

## Step 3: Inspect current ownership

Read the file's YAML frontmatter. Check the `_origin` field:

| Current `_origin` | Action |
|---|---|
| `calsuite@<sha>` | **Warn:** "This is calsuite's canonical version. Customising will stop calsuite updates from reaching this file. Continue?" via `AskUserQuestion`. If the user declines, abort. |
| `<target-name>` (anything non-calsuite) | Already user-owned. Proceed without warning. |
| Missing (pre-protocol install) | Treat as calsuite-owned. Same warning as the first row. |

## Step 4: Apply edits

**Path A — instructions provided in `$ARGUMENTS`:**

Dispatch an implementer agent:

```text
prompt: "Modify the skill file at <skill_path> to: <instructions>.

Constraints:
- Preserve the YAML frontmatter block (the lines between the first and second `---`) EXACTLY. Do not change any field, do not add or remove fields, do not touch the `_origin` line.
- Keep the existing overall structure and tone unless the instructions specifically require otherwise.
- Make only the changes the instructions call for — no drive-by reformatting.

Return: a terse summary of what you changed (2-3 bullet points, file:line if relevant)."
description: "Customise <skill-name>: <short description of instructions>"
```

**Path B — no instructions (interactive):**

Tell the user:

> Open `<skill_path>` and make your edits. Frontmatter fields starting with `_` (like `_origin`) will be managed for you — don't touch them. Reply here when you're done.

Wait for their next message. When they return:

1. Re-read the file.
2. If it's unchanged from before, ask via `AskUserQuestion`: "No changes detected. Claim anyway (keep current content, just mark as user-owned)?" If no, abort without writing.
3. If changed, proceed to Step 5.

## Step 5: Claim the file

Invoke calsuite's `--claim` to stamp `_origin: <target-name>`. Reuses `$calsuite_dir` from Step 0 — the pre-flight guard has already confirmed it's reachable:

```bash
abs_path="$(cd "$(dirname "$skill_path")" && pwd)/$(basename "$skill_path")"
node "$calsuite_dir/scripts/configure-claude.js" --claim "$abs_path"
```

`--claim` infers the target name from the directory structure (e.g., `~/Projects/verity/.claude/skills/ship/SKILL.md` → `_origin: verity`).

## Step 6: Summary

Report:

```text
Customised <skill-name>:
  File:      <relative path>
  _origin:   <target-name> (was: <calsuite@sha | user-claimed | unmarked>)
  Changes:   <one-line summary from Step 4, or "no content changes — claim only">

Future calsuite --sync will skip this file.
```

## Gotchas

- **Only `SKILL.md` is claimed.** Supporting files in the same dir (e.g. `pr-template.md`, `checklist.md`) are still calsuite-owned and will be updated by `--sync`. If you edit those too, run `node "$CALSUITE_DIR/scripts/configure-claude.js" --claim <path>` manually for each.
- **Claiming is per-target.** If verity and timeline both want the same customisation, run `/customise` in each. They diverge independently.
- **To un-claim** (go back to calsuite's canonical version, discarding your edits): `node "$CALSUITE_DIR/scripts/configure-claude.js" --force-adopt <path> --yes`.
- **`$CALSUITE_DIR`** defaults to `~/Projects/calsuite`. Override via shell env if you keep calsuite elsewhere.
- **Don't touch `_origin` by hand.** Let `--claim` / `--force-adopt` manage it. A wrong value won't corrupt anything, but will put the file into an unexpected state in the safe-overwrite matrix.
