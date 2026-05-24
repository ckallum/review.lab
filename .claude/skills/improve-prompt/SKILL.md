---
_origin: calsuite@9ceb0ce
name: improve-prompt
description: Audit and rewrite a prompt against Anthropic's prompt engineering best practices. Use for system prompts in Claude API apps, agent definitions, skill bodies, or any prompt content you want sharper. Not for tuning effort/thinking/model config — that's /claude-api's job.
user-invocable: true
arguments: Optional path to a file, "above"/"last" for the most recent assistant output, or paste the prompt inline. Defaults to asking what to improve.
---

# /improve-prompt

Apply [Anthropic's prompt engineering best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) to a single prompt. Audit against the checklist, then return a revised prompt. For long or multi-section prompts (system prompts > 200 lines, complex agent definitions), run the audit-revise loop twice.

This is for **prompt content** — the words that go into a system prompt, agent body, or skill. It is NOT for tuning API-side knobs (effort, adaptive thinking, model selection, prefill migration). If the user wants to tune those, route to `/claude-api`.

If invoked on a terse one-line user message or commit-style instruction, confirm the user wants this — short imperative text shouldn't be padded with structure.

## Arguments

- `<path>` — read prompt from a file path (e.g. `agents/foo.md`, `skills/bar/SKILL.md`, `src/prompts/system.txt`).
- `above` / `last` — target the most recent assistant message in this conversation.
- `<inline text>` — treat the argument itself as the prompt to improve.
- omitted — ask the user what to improve and where the prompt lives.

## Resolving input

In order:
1. If `$ARGUMENTS` is a file path, read the file. For markdown skill/agent files, the prompt is the body after frontmatter.
2. If `$ARGUMENTS` is `above` or `last`, target the most recent assistant message.
3. If `$ARGUMENTS` is text longer than ~20 words, treat it as the input.
4. Otherwise ask the user to paste the prompt or give a path. Also ask **what the prompt is for** (one-shot completion, agent system prompt, RAG over long docs, tool-using agent) — the right structure depends on the use case.

## Ruleset

Precedence: correctness/safety > user constraints > use-case norms > core rules > stylistic preferences.

Audit before rewriting. Do not rewrite a prompt that is already tight — return it unchanged with a one-line note.

### Core rules

1. **Colleague test.** A colleague with no context should be able to follow the prompt and produce the right output. If they'd be confused — under-specified output format, missing constraints, ambiguous tool routing — the model will be too. This is the single highest-yield check.
2. **Be specific about what you want, not what you don't.** `Your response should be flowing prose paragraphs.` beats `Do not use markdown.` Positive instructions steer better than prohibitions. Negative-only instructions invite the model to find creative workarounds.
3. **Explain why, briefly.** One line of motivation (`...because the output is read aloud by a TTS engine`) lets the model generalize to edge cases. Don't pad — one sentence per non-obvious constraint is enough.
4. **Examples are the strongest steering tool.** For format, tone, or structure: include 3–5 examples wrapped in `<example>` tags (multiple inside `<examples>`). Make them diverse enough that the model doesn't lock onto incidental patterns. One example is rarely enough; ten is overkill for most cases.
5. **XML-tag the structural sections.** When a prompt mixes instructions, context, input documents, and examples, wrap each in a descriptive tag (`<instructions>`, `<context>`, `<input>`, `<examples>`, `<document>`). Reduces misparsing on complex prompts. Single-purpose prompts under ~30 lines don't need this.
6. **Role goes in the system prompt, not the user turn.** One sentence is enough (`You are a senior infrastructure engineer reviewing a Terraform diff.`). Long persona descriptions rarely outperform a short, specific role.
7. **Long-context layout.** Documents at the top, query at the bottom. Wrap each document in `<document index="n">` with `<source>` and `<document_content>` subtags. For RAG-style prompts, ask the model to quote relevant passages first inside `<quotes>` tags before answering — grounds the response in the docs and cuts hallucination.
8. **Match prompt style to output style.** If you want plain prose output, write the prompt as plain prose. If the prompt is heavy markdown, the output drifts toward heavy markdown. Cohere prompt format with desired output format.
9. **Tool-using prompts: instruct, don't suggest.** `Make these edits to the auth flow.` causes action. `Could you suggest some improvements?` causes suggestions. If the prompt's goal is action, write imperative verbs. Add `<default_to_action>` framing only when the use case actually wants proactive tool use.
10. **Don't over-emphasize.** `CRITICAL: You MUST use this tool when…` overtriggers on newer models (Opus 4.5+). Use neutral phrasing (`Use this tool when…`) and let the model judge. Reserve emphatic caps for genuine correctness invariants.
11. **Chain-of-thought when reasoning matters.** If the task needs multi-step reasoning and adaptive thinking isn't enabled, ask the model to think first inside `<thinking>` tags and answer inside `<answer>` tags. Use the word "think" or "reason through" — and with newer models, alternatives like "consider" / "evaluate" work too.
12. **Self-check as a final pass.** `Before finishing, verify your answer against [criteria].` catches arithmetic, off-by-one, and contradiction errors reliably. Cheap to add, high yield.

### Use-case-specific layers

Add on top of the core rules:

- **Agent system prompts.** State the agent's name, scope (what it does, what it doesn't), and stopping condition. Be explicit about whether the agent should ask the user vs. proceed autonomously. List the tools it has and when to reach for each. Include a "report" or "output" section if the agent returns to a parent.
- **Code-review prompts.** If the harness has separate filtering, tell the model its job at this stage is **coverage, not filtering** — otherwise newer models faithfully obey "be conservative" and silently drop real findings. Move severity/confidence filtering into a downstream pass.
- **Long-document prompts (20k+ tokens).** Documents first, query last. XML-wrap each document. Grounding-in-quotes pass before the answer.
- **Frontend / design prompts.** Specify concrete alternatives, not negations. `Use a cold monochrome palette: #E9ECEC, #C9D2D4, #8C9A9E.` beats `Don't use cream and serif.` Newer models have strong default aesthetics — generic negations shift them to a different fixed default, not variety.
- **Autonomous coding agents.** Specify task, intent, and constraints upfront in the first user turn rather than progressively. Ambiguity early costs token efficiency later.

### Anti-patterns to flag

- Negative-only instructions with no positive replacement.
- Persona inflation: paragraphs of character backstory in the system prompt.
- Restating the same instruction in three different phrasings — one well-formed instruction outperforms three approximate ones.
- Heavy caps + bold + `CRITICAL` stacking on every instruction. Loses signal; everything ends up emphasized, so nothing is.
- Asking for `<thinking>` tags around content the model will answer in one step — adds latency, no quality gain.
- "Step 1, step 2, step 3" for tasks that aren't actually sequential. Mechanical scripts over goals reduce model judgment.
- Time-stamped claims (`as of November 2025…`) baked into a reusable system prompt. State invariants, not snapshots.

## Required checks

For short prompts (≤ ~30 lines): run checks 1–4.
For long / multi-section prompts: run all.

1. **Colleague test.** Could a new hire follow this and produce the right output? Name what is ambiguous.
2. **Specificity.** Does the prompt say what to do (not just what to avoid)? Are constraints stated, not assumed?
3. **Examples.** If format or tone matters, are there 3–5 diverse examples in `<example>` tags? If not, propose example shapes.
4. **Over-emphasis.** Count uses of `CRITICAL`, `MUST`, `NEVER`, all-caps imperatives. More than 2–3 in a short prompt is likely overtuned for older models.
5. **Structure.** Are instructions, context, input, and examples in separate XML tags? Does the order match long-context guidance (docs top, query bottom)?
6. **Stance.** Tool-using prompt — are verbs imperative or suggestive? Does it match the desired behavior (action vs. recommendation)?
7. **Over-correction.** Did the rewrite strip useful structure to "sound less prompt-engineered"? Bring back what was load-bearing.

Tripwires, not goals. Don't print the audit unless asked.

## Output

1. **Revised prompt.** Show the rewritten version. If the input came from a file, propose an Edit rather than overwriting silently.
2. **Diff summary.** 3–5 bullets naming the changes (e.g. "added 3 `<example>` blocks", "moved query below documents", "softened `CRITICAL: MUST` to `Use when…`"). One line each.
3. **If already tight, say so.** Return the prompt unchanged with one line explaining why no edits were needed. Do not invent improvements.
4. **If the diagnosis is "wrong tool, not bad prompt"** — e.g. the user is fighting model behavior that wants a config change (effort, thinking, model choice) — say so and point at `/claude-api`. Don't paper over an API-side problem with prose.

## Gotchas

- The Anthropic doc covers both **prompt content** and **model/API config** (effort, adaptive thinking, prefill migration). This skill is scoped to content only. If the user's actual problem is config — wrong effort level, missing `thinking: {type: "adaptive"}`, model mismatch — name it and defer to `/claude-api`.
- "Improving" a prompt sometimes means **deleting**, not adding. Over-engineered prompts with 200 lines of caveats often outperform after a cut. Don't reflexively expand.
- When auditing a `skills/<name>/SKILL.md` file, remember the description field is for model-side triggering, not user-facing prose. Different rules apply — 5–8 trigger phrases, not a paragraph. Cross-reference `skills/skill-builder/references/best-practices.md` if the input is a SKILL.md.
- Few-shot examples inflate token cost. For latency-sensitive workloads, the prompt-engineer-vs-cost tradeoff is real; flag it if the prompt is for a high-volume API path.
- Don't rewrite prompts in *other people's voices* without permission. If the input is a user-authored agent definition with personality, preserve the voice and tighten only the mechanics.

## References

- Upstream source: [Anthropic prompt engineering best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) — re-fetch with `WebFetch` if the user asks about a section not covered above (e.g. computer use, vision, document creation).
- `references/checklist.md` — single-page audit checklist for fast passes.
