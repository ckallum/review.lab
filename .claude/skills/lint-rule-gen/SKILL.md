---
_origin: calsuite@2a7c883
name: lint-rule-gen
version: 1.0.0
description: |
  Generate lint rules from review feedback patterns.
  Aliases: /lint-rule-gen, /generate-lint-rule
argument-hint: "[description of pattern to catch]"
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

# Lint Rule Generator

Generate ESLint rules or agent-rules from review feedback, conversation patterns, or explicit descriptions.

## Invocation

```
/lint-rule-gen                           # Analyze recent review feedback for patterns
/lint-rule-gen "ban console.log in src"  # Generate rule from description
```

## Process

### Step 1: Gather Pattern

If an argument was provided, use it as the pattern description. Otherwise:

1. Check recent git log for review-related commits:
   ```bash
   git log --oneline -20 --grep="review\|fix\|lint\|convention"
   ```

2. Check for `@code-reviewer` feedback in recent diffs:
   ```bash
   git log -5 --format="%H" | head -5
   ```

3. Look at `.claude/guardian/logs/` for recent warn/deny patterns.

4. Ask the user what recurring pattern they want to encode.

### Step 2: Determine Rule Type

Decide which rule system fits best:

| Pattern Type | Rule System | Config File |
|---|---|---|
| AST-level code pattern | ESLint rule | `.eslintrc.json` |
| Text/regex pattern in source | Agent rule | `.claude/config/agent-rules.json` |
| Tool call / operation pattern | Guardian rule | `.claude/config/guardian-rules.json` |
| File existence / structure | Agent rule (check type) | `.claude/config/agent-rules.json` |

### Step 3: Generate the Rule

For **agent-rules** (most common), generate a JSON entry:

```json
{
  "id": "descriptive-kebab-id",
  "pattern": "regex pattern (use null if using check instead)",
  "files": "glob pattern for target files",
  "exclude": ["globs to skip"],
  "severity": "error|warn|info",
  "message": "Human-readable explanation with fix suggestion",
  "autofix": null,
  "check": "optional: colocated-test (mutually exclusive with pattern)"
}
```

For **guardian rules**, generate a deny or warn entry:

```json
{
  "id": "deny-or-warn-id",
  "tool": "Bash|Write|Edit",
  "match": { "command": "regex" },
  "reason": "Why this is blocked"
}
```

For **ESLint rules**, suggest the appropriate built-in or plugin rule with config.

### Step 4: Validate

1. Test the regex pattern against the codebase to find existing violations:
   ```bash
   grep -rn "PATTERN" --include="*.ts" --include="*.js" src/
   ```

2. Show the user how many existing files would be affected.

3. Suggest starting as `warn` severity if there are many existing violations, then promoting to `error` after cleanup.

### Step 5: Install

1. Read the target config file (agent-rules.json, guardian-rules.json, or .eslintrc.json).
2. Add the new rule entry.
3. Write the updated config.
4. Report what was added.

### Step 6: Verify

Run the lint-gate or eslint check to confirm the new rule catches the intended pattern:

```bash
# For agent rules — test the pattern against the codebase
grep -rn "PATTERN" --include="*.ts" --include="*.js" src/

# Then stage files and do a test commit to trigger lint-gate:
# git add . && git commit -m "test [skip-review]"

# For ESLint — run on target files
npx eslint --rule '{"rule-name": "error"}' src/
```

## Output Format

After generating a rule, output:

```
✓ Generated [rule-type] rule: [rule-id]
  Pattern: [regex or rule name]
  Files: [glob]
  Severity: [level]
  Existing violations: [count] files

  Rule added to: [config file path]
```
