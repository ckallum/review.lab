---
_origin: calsuite@0ce554a
name: improve-architecture
version: 1.0.0
description: |
  improve architecture, codebase health check, find refactor opportunities, identify shallow modules,
  deepen this code, ball of mud rescue, ai navigability audit, codebase entropy review,
  proactive refactor pass, find seams, surface architectural friction.
  Periodic codebase-wide review that finds shallow modules and proposes deepening opportunities —
  refactors that turn shallow modules into deep ones for testability and AI-navigability.
  Informed by CONTEXT.md (domain) and docs/adr/ (locked-in decisions).
user-invocable: true
argument-hint: "[path-or-module] [--candidates-only]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent
  - AskUserQuestion
  - Edit
  - Write
---

# /improve-architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The goal is testability and AI-navigability: a codebase a fresh agent can navigate quickly, with bugs concentrated in one place, not scattered.

Run periodically — every few weeks, or when the codebase starts to feel like a ball of mud. Pairs with `/code-review` (per-change cleanup) and `/review` (pre-merge) — `/improve-architecture` is the **codebase-wide health check** the others don't do.

## Vocabulary

This skill uses a fixed architectural vocabulary. Read [LANGUAGE.md](./LANGUAGE.md) **before generating any suggestions** and use these terms exactly. Drift to "component", "service", "API", "boundary", "layer", or "abstraction" defeats the point of having shared language. Quick reference:

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know: types, invariants, ordering, error modes, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface. **Deep** = lots of behaviour behind a small interface. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place.
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (full list in LANGUAGE.md):

- **Deletion test:** imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Arguments

- `/improve-architecture` — full codebase pass.
- `/improve-architecture <path>` — restrict the audit to a path or module (e.g. `/improve-architecture src/billing/`).
- `--candidates-only` — present the numbered list of deepening opportunities and stop. Don't drop into the grilling loop.

## Process

### Step 1: Read the project's domain artifacts

Before exploring code, load context:

- **`CONTEXT.md`** at the repo root (or `CONTEXT-MAP.md` pointing to per-module `CONTEXT.md` files). The domain glossary names good seams — refactors that align with domain boundaries are worth more than ones that cut across them. If no `CONTEXT.md` exists, that itself is informative — note it; you may surface it as a candidate ("the codebase lacks a domain glossary, propose creating one").
- **`docs/adr/`** (or `<context>/docs/adr/`) — read every ADR touching the area you'll audit. Don't propose refactors that contradict an accepted ADR unless the friction is real enough to warrant revisiting it (in which case mark the suggestion `contradicts ADR-NNNN — but worth reopening because…`).
- **`.out-of-scope/`** — if it exists, read prior rejections (written by `/sweep-issues` when an enhancement is closed `wontfix`). Don't re-surface candidates already rejected for durable reasons. If a prior rejection seems wrong now because conditions changed, surface that reasoning rather than silently re-suggesting.

### Step 2: Explore

Dispatch an `Explore` agent to walk the codebase (or the path argument if scoped):

```text
prompt: "Walk the codebase at <path or repo root>. Read CLAUDE.md and CONTEXT.md if they exist.

Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?
- Are there pass-through modules that just forward calls (failing the deletion test)?

For each spot of friction, capture: file/module path, what's friction-y, an initial hypothesis about whether deepening would help. Don't propose solutions yet — just report observations.

Return a structured list of friction observations grouped by area."
description: "Architectural friction scan"
```

Use Grep / Glob yourself to verify a few of the agent's claims before passing them through.

### Step 3: Apply the deletion test

For every candidate the explore agent flagged as a shallow module, apply the **deletion test**:

> Imagine deleting this module. Does complexity vanish? Or does it reappear across N callers?

- **Vanishes** → the module was a pass-through, doesn't pay its way. Strong deepen-or-inline candidate.
- **Reappears across many callers** → the module is earning its keep, even if its current interface is awkward. Probably keep, possibly redesign the interface.
- **Reappears in one caller** → consider inlining; one-caller modules rarely earn their interface tax.

This is the most important filter — most "shallow" complaints are just preferences. The deletion test is a real argument.

### Step 4: Present candidates

Present a numbered list of deepening opportunities. For each:

- **Files** — which files / modules are involved.
- **Problem** — why the current architecture causes friction (in vocabulary terms — depth, leverage, locality, seam).
- **Solution** — plain-English description of the proposed deepening. Don't propose a concrete interface yet.
- **Benefits** — explained in terms of locality and leverage, plus how tests would improve. Reference the deletion test outcome.
- **Risk / cost** — what would the refactor touch, and roughly how big.
- **ADR conflicts** — flag any contradiction with existing ADRs.

Use `CONTEXT.md` vocabulary for **domain** ("the Order intake module", not "the FooBarHandler"), and LANGUAGE.md vocabulary for **architecture** ("shallow seam", not "thin abstraction layer").

If `--candidates-only` is set, stop here.

Otherwise ask the user via AskUserQuestion: *"Which of these would you like to explore? A) #N B) #M C) None — close the audit"*.

### Step 5: Grilling loop (per chosen candidate)

Once the user picks a candidate, drop into a `/plan --grill`-style conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

**Side effects happen inline as decisions crystallize:**

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md` right there using the format below. Same discipline as `/plan --grill`.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` inline.
- **User rejects the candidate?** Persist the rejection **immediately, here, at rejection time** — don't defer to `/sweep-issues` (it may never run, and the next audit will re-suggest the same candidate). Two paths:
  1. **Durable reason that meets all three ADR criteria** (hard to reverse, surprising without context, real trade-off): write `docs/adr/NNNN-kebab-title.md` now using the format below. Frame the offer as: *"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"*
  2. **Durable reason that doesn't meet all three** (e.g. "we'd revisit if we add multi-tenancy"): write `.out-of-scope/<kebab-slug>.md` now (format documented in `/sweep-issues` SKILL.md — `slug`, `rejected`, `related-issues` frontmatter, plus "Why we rejected it" and "What would change our minds" body sections). The next audit reads this and skips the candidate.

  Only skip persistence entirely if the user explicitly marks the rejection **ephemeral** (e.g. "not worth it right now", "ask me again next quarter") — those don't need durable records because the reasoning won't apply later.

### `CONTEXT.md` format (when adding terms inline)

```md
**{Term}**:
{One-sentence definition.}
_Avoid_: {alias 1}, {alias 2}
```

Be opinionated, one canonical word per concept. Group under `## Language`, with `## Relationships`, `## Example dialogue`, and `## Flagged ambiguities` sections. Domain-only — no general programming concepts.

### ADR format (at `docs/adr/NNNN-kebab-title.md`)

```md
# ADR-{NNNN}: {Verb-led title}

**Status:** Accepted
**Date:** YYYY-MM-DD

## Context
{What forced the decision.}

## Decision
{What we decided.}

## Consequences
**Positive:** {what gets easier}
**Negative:** {what gets harder}

## Alternatives considered
- **{Alternative}** — rejected because {reason}
```

Filename zero-padded sequential, verb-led title. Immutable once accepted — supersede with a new ADR rather than editing.
- **User accepts the candidate and wants to implement?** Stop here — do **not** start coding inside `/improve-architecture`. Hand off: *"Run `/plan review` on this candidate, then `/execute`. I'll keep audit notes in CONTEXT.md / docs/adr/."* The skill is a surfacing-and-deciding tool, not an implementation tool.

### Step 6: Write audit notes

After the grilling loop, write a short audit summary to `.context/architecture-audits/YYYY-MM-DD.md`:

```markdown
# Architecture audit — YYYY-MM-DD

Scope: <full codebase | path argument>

## Candidates surfaced
1. **<name>** — <one-line problem> — <decision: deepen / defer / rejected via ADR-NNNN>
2. ...

## Decisions
- <bullet per resolved candidate>

## CONTEXT.md updates
- Added term: <term> — <reason>
- Sharpened term: <term> — <reason>

## ADRs written
- ADR-NNNN: <title>

## Next steps
- /plan review <candidate slug>
- /execute spec <slug>
```

This gives the next audit (in a few weeks) a starting point and prevents re-litigating the same candidates.

## Gotchas

- **Don't propose interfaces in Step 4.** Wait for the user to pick a candidate. Proposing concrete interfaces upfront is wasted work — most candidates won't be picked.
- **Use the deletion test, not feel.** "This feels too shallow" is not a finding. "Deleting this module would push complexity into 5 callers, none of which would benefit from owning that complexity" is.
- **Don't re-litigate ADRs unprompted.** If a candidate contradicts an ADR and the friction isn't severe, drop it silently. Only surface ADR-contradicting candidates when the friction is real and worth a discussion.
- **Stay codebase-wide unless scoped.** This is the proactive health check — `/code-review` already covers per-change cleanup. If the user wants a focused review, they'll pass a path argument.
- **The skill is read-and-decide, not write-and-implement.** When a candidate is approved, hand off to `/plan review` → `/execute`. Don't refactor inside this skill.
- **AFK / HITL marking on follow-up issues.** When approved candidates spawn issues (via `/sweep-issues`), tag them AFK (clearly-spec'd refactor) or HITL (needs design decision) per the standard convention.
