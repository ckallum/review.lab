---
_origin: calsuite@0ce554a
_origin:
---

# Audit checklist — fast pass

A single-page checklist for triaging a prompt. Use when the user wants a quick pass rather than a full rewrite. Each item is a yes/no — if "no", note what to add or change.

## Clarity (always run)

- [ ] Could a colleague with no context follow this and produce the right output?
- [ ] Is the desired output format stated explicitly (length, structure, tone)?
- [ ] Are constraints positive (`do X`), not just negative (`don't do Y`)?
- [ ] Is the *why* explained for any non-obvious constraint (one sentence)?

## Examples (if format or tone matters)

- [ ] 3–5 examples present?
- [ ] Wrapped in `<example>` tags (and `<examples>` for the set)?
- [ ] Diverse enough to cover edge cases (not three near-duplicates)?
- [ ] Examples mirror the actual production use case?

## Structure (for prompts mixing multiple content types)

- [ ] Instructions, context, input, examples each in their own XML tag?
- [ ] Long documents at the top, query at the bottom?
- [ ] Documents wrapped in `<document index="n">` with `<source>` and `<document_content>` subtags?
- [ ] For long-context RAG: grounding-in-quotes pass requested before the answer?

## Role and voice

- [ ] Role stated in one sentence in the system prompt (not a paragraph of backstory)?
- [ ] Prompt style matches desired output style (plain prose prompt → plain prose output)?

## Tool use and action

- [ ] If the goal is action: are verbs imperative (`make these edits`) not suggestive (`could you suggest`)?
- [ ] Tool routing rules stated: when to call which tool?
- [ ] Parallel-vs-sequential tool-call guidance, if relevant?

## Reasoning

- [ ] For multi-step tasks: `<thinking>` / `<answer>` structure or adaptive thinking guidance?
- [ ] Self-check pass at the end (`Before finishing, verify…`)?

## Over-emphasis (high-yield check on older prompts)

- [ ] Count of `CRITICAL` / `MUST` / `NEVER` / all-caps imperatives is under ~3?
- [ ] If higher, are they actually load-bearing correctness rules, or stylistic insistence?

## Anti-patterns

- [ ] No persona inflation (paragraphs of character backstory)?
- [ ] No restating the same instruction in three phrasings?
- [ ] No mechanical step-by-step where goal-based framing would do?
- [ ] No time-stamped claims baked into a reusable system prompt?
- [ ] No `<thinking>` tags around content the model answers in one step?

## Scope sanity

- [ ] Is the user's actual problem **content** (this skill's job) or **config** (`/claude-api`'s job — effort, thinking, model)?
- [ ] If content: is the input prompt too short to need this? (Single-line instructions rarely benefit from a rewrite.)

## Final pass

- [ ] After rewriting: did anything load-bearing get cut in the name of "tightening"?
- [ ] Diff summary ready (3–5 one-line bullets)?
