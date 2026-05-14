---
_origin: calsuite@2a7c883
name: new-spec
description: |
  Scaffold a new spec directory with requirements.md, design.md, and tasks.md
  templates. Adds a row to SPECLOG.md.
argument-hint: <slug>
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# /new-spec: Spec Directory Scaffolder

Create a new spec directory with the three standard files and register it in SPECLOG.md.

## Arguments

- `/new-spec <slug>` — create `.claude/specs/<slug>/` with templates

## Instructions

### 1. Check it doesn't exist

```bash
ls .claude/specs/$ARGUMENTS/ 2>/dev/null && echo "EXISTS" || echo "OK"
```

If it exists, tell the user and stop.

### 2. Create the directory and files

Create `.claude/specs/$ARGUMENTS/requirements.md`:

```markdown
# <Title> — Requirements

## User Stories

- As a [role], I want [action], so that [benefit]

## Functional Requirements

1. **FR-1:** [requirement]

## Non-Functional Requirements

1. **NFR-1:** [requirement]

## Out of Scope

- [what's explicitly excluded]
```

Create `.claude/specs/$ARGUMENTS/design.md`:

```markdown
# <Title> — Design

## Architecture

[How this fits into the existing system]

## Data Model

[New tables, columns, relationships]

## API Design

[New or modified endpoints]

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| | | |

## Security Considerations

[Auth, RLS, input validation]
```

Create `.claude/specs/$ARGUMENTS/tasks.md`:

```markdown
# <Title> — Tasks

## Phase 1: Foundation

- [ ] Task 1
- [ ] Task 2

## Phase 2: Core Implementation

- [ ] Task 3
- [ ] Task 4

## Phase 3: Polish & Testing

- [ ] Tests
- [ ] Documentation
```

### 3. Update SPECLOG.md

Read SPECLOG.md and add a new row to the table with status "Not Started".

### 4. Report

Tell the user:
- Created `.claude/specs/$ARGUMENTS/` with requirements.md, design.md, tasks.md
- Added row to SPECLOG.md
- Next step: run `/plan interview $ARGUMENTS` to flesh out the spec

## Gotchas

- Slug should be kebab-case (e.g., `user-notifications` not `userNotifications`)
- Don't populate the templates with content — that's what `/plan interview` is for
- SPECLOG.md table format must match existing rows exactly
