---
_origin: calsuite@2a7c883
name: zoom-out
version: 1.0.0
description: |
  zoom out, give me a map, broader context, higher-level perspective, what's the big picture,
  how does this fit, walk me through this area, I don't know this code, unfamiliar code,
  give me the lay of the land, sketch the architecture here.
  Single-purpose: agent goes up a layer of abstraction and produces a callers-and-collaborators
  map for an unfamiliar area of code, using the project's domain vocabulary if CONTEXT.md exists.
user-invocable: true
argument-hint: "[path-or-symbol]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Agent
---

# /zoom-out

You are unfamiliar with this area of code. Go **up** one layer of abstraction and produce a map.

## Arguments

- `/zoom-out` — no argument; infer the target from the recent conversation (last file read, last function discussed) and confirm with the user before mapping.
- `/zoom-out <path-or-symbol>` — explicit target. The argument is matched against `argument-hint: "[path-or-symbol]"` in the frontmatter:
  - **Path** (e.g. `src/billing/charges.ts`) — start there; map its module / package as the broader scope.
  - **Symbol** (e.g. `applyDiscount`) — grep for the definition first, then proceed.
  - Empty or ambiguous — fall through to the inference path above.

The argument resolves at **Step 1: Resolve the target** in the Process below. Tools available are read-only (`Read`, `Grep`, `Glob`, `Agent` per the frontmatter) — the skill cannot modify files.

## Process

1. **Resolve the target.** If `$ARGUMENTS` is a path, start there. If it's a symbol, grep for the definition. If empty, infer from the recent conversation (last file read, last function discussed) and confirm with the user before proceeding.

2. **Read CONTEXT.md if it exists.** Check the repo root and any closer `CONTEXT.md` (multi-context repos use a `CONTEXT-MAP.md` at root pointing to per-module files). If found, **use its vocabulary exactly** — don't drift to synonyms. If absent, just describe the code in its own terms.

3. **Build the map.** Use Grep / Glob to enumerate:
   - **Callers** — who imports / invokes this module?
   - **Collaborators** — what does it import / depend on?
   - **Siblings** — peer modules in the same directory or layer.
   - **Entry points** — what user-facing surface (route, CLI command, hook event, job) ultimately reaches it?

   For larger areas, dispatch an `Explore` agent rather than walking the tree yourself.

4. **Output.** A short hierarchical map plus 3-5 sentences of orientation. Format:

   ```text
   <Target> sits inside <broader concept from CONTEXT.md or filesystem>.

   Reached from:
     - <entry point> → <intermediate> → <target>
     - <entry point> → <target>

   Calls into:
     - <collaborator> — <what for>
     - <collaborator> — <what for>

   Peers (sibling modules):
     - <peer> — <one-line role>
     - <peer> — <one-line role>

   Tests:
     - <test file> — covers <surface>

   Notes
     - <one or two non-obvious facts: invariant, recent refactor, ADR reference>
   ```

5. **Stop.** Don't propose changes, don't fix things, don't grill. The goal is orientation only — the user takes it from there.

## Gotchas

- **Don't dump file contents** — the user already knows how to read. The job is shape and relationships, not source code.
- **Don't speculate about what code "should" do.** Map what's there. If something is confusing, list it under Notes as a question, not a recommendation.
- **Use CONTEXT.md vocabulary verbatim.** If the glossary calls it an "Order intake module," don't rewrite as "the order service." Drift defeats the point of having a glossary.
- **Stay one layer up, not three.** Zooming too far loses signal. If the target is a function, map its module. If the target is a module, map its package. One step.
