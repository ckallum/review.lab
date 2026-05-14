---
_origin: calsuite@2a7c883
name: humanize
description: Audit and rewrite prose to remove AI tells. Use for blog posts, external docs, READMEs, long-form PR bodies, public-facing copy. Not for code, terse status updates, or routine commit messages — sterile is correct there.
user-invocable: true
arguments: Optional path to a file, "above" for the most recent assistant output, or paste text inline. Defaults to asking what to humanize.
---

# /humanize

Apply [Anbeeld's WRITING.md](https://github.com/Anbeeld/WRITING.md) ruleset to a piece of prose. Audit, then revise. For long pieces, run the audit-revise loop twice.

This is for content writing. If invoked on terse work output (a status note, a commit message, a one-line PR comment), confirm the user actually wants this — short utilitarian text shouldn't perform voice.

## Arguments

- `<path>` — read prose from a file path.
- `above` / `last` — target the most recent assistant message in this conversation.
- `<inline text>` — treat the argument itself as the prose to humanize.
- omitted — ask the user what to humanize.

## Resolving input

In order:
1. If `$ARGUMENTS` is a file path, read the file.
2. If `$ARGUMENTS` is `above` or `last`, target the most recent assistant message in this conversation.
3. If `$ARGUMENTS` is text, treat it as the input.
4. Otherwise ask the user to paste the text or give a path.

## Ruleset

Precedence: truth/safety/accessibility > user instructions > genre norms > core rules > watchlists.

### Workflow

1. Identify medium, audience, reader need, job of the text.
2. If task-oriented: identify the answer or next action that belongs first.
3. If long-form: decide the through-line and one concrete example that can carry weight.
4. Draft to fit that context, not an abstract idea of good writing.
5. Run the required checks.
6. Cut what sounds generic, ceremonial, over-engineered, or too cleanly modular.

### Medium routing

- Chat, comments, DMs: prose by default. Lists only when naturally list-like. No decorative formatting. Straight quotes in plain text.
- Email: prose first; lists for discrete items.
- Documents, specs, tech writing: structure expected.
- Web, help, UI text: answer early. Preserve scannability.
- Long-form: structure on purpose. Pick an angle, not a timeline.

### Safety rails

Em dashes, semicolons, `however`, competent punctuation, and the right word are not AI tells. Do not invent typos, break grammar, inject fake uncertainty, or program sentence-length wobble. In casual prose, repeated em dashes are a social AI cue — use where they belong, not as default. Do not strip needed headings, lists, citations, or next steps to sound less AI-written.

### Core rules

1. **Anchor to context before drafting.** A reply paste-able into any thread on the topic reads generic. Keep register stable.
2. **Fit format to medium.** Over-structuring casual writing makes it templated. Under-structuring technical writing makes it unusable.
3. **Concrete specificity over polished generality.** Each substantial paragraph needs a concrete anchor: proper noun, specific number, direct quote, named decision, or checkable detail. `many`, `various`, `meaningful`, `essentially`, `fundamentally`, `ultimately`, bare milestone names — do not count. Earn specificity. Do not invent milestones, synthetic quotes, or suspiciously exact claims. Cannot verify? Attribute, soften, or cut. Where causation is unconfirmed, use `coincided with` or `was followed by`, not `caused` or `drove`.
4. **Plain words, verbs, reference.** Do not chase synonyms for `problem`, `change`, `system`, `work`, `people`. Prefer `we changed it` to `the implementation of the change`. Cohere through pronouns, not `Furthermore` / `Moreover` / `Additionally` / `Importantly`.
5. **Do not perform.** No keynote cadence, mission phrasing, ceremonial wrap-ups. No `Great question`, `I hope this helps`, `Feel free to reach out` unless the situation clearly calls for it. Start where the answer starts. Stop where it stops.
6. **Calibrate stance to genre.** Confident where evidence is strong, explicit where it is weak. Visible writer where the genre expects one; neutral where it expects it. Don't sand to uniform mildness or manufacture views.
7. **Show concrete before generalizing.** Usually: what happened → where the pattern appeared → what constraint mattered → what failed or changed → what that seems to mean.
8. **Watch regularity.** The most visible LLM tell is its own regularity: parallel enumeration, three-part cadence, sentences doing hidden list work, concession-plus-positive rhythm (`not X, but Y`), paragraph-closing type definitions (`the kind of X where Y`), identical paragraph arcs, same punctuation move every paragraph, thesis-like openings, stacked mini-sentences. Three-item lists count. Fix by breaking the dominant pattern, not by random variation.
9. **Develop thought; choose structure.** Longer pieces should not feel pre-solved. Include a concrete example, noticed detail, or brief doubling-back. For retrospectives, criticism, feature writing: avoid chronological march, topic buckets, catalog prose. If each paragraph reduces to a single label (`background`, `mechanism`, `impact`, `verdict`), it's system-tour prose — restructure. Alternatives: thematic, reverse-chronological, perspective-led, counterfactual, opinion-first, single-example-led.
10. **Revise by cutting.** Re-read as a first-time reader. Cut auditioning, announcements, restating paragraphs, the most generic clause. Most edits should shorten.

### Required checks

Short pieces (≤ ~150 words): run 1–3 and 5. Longer: run all.

1. **Register fit.** Format, punctuation, structure match medium and request? Accessibility preserved?
2. **Concrete anchor.** One per substantial paragraph; if none, add or cut. If citing a source, confirm it supports the exact claim.
3. **Regularity tripwire.** Name the most repeated pattern. Appears 3+ times or dominates two consecutive paragraphs? Rewrite one.
4. **Stance and shape.** Genre expects a writer? State the view in one sentence; if you can't, add stance. Long piece? State organizing principle in five words; if it's just the genre default, restructure.
5. **Over-correction.** Added fake-human moves to break a pattern?

Tripwires, not goals. Don't output the audit unless asked.

### Watchlist

Scrutinize when defaulting to: `delve`, `tapestry`, `leverage`, `realm`, `robust`, `seamless`, `holistic`, `underscore`; `it's important to note`, `when it comes to`, `in conclusion`, `the kind of X where Y`; vague authority (`experts say` unnamed); unsupported causality (`X drove Y` without evidence); smart quotes in plain text; decorative emoji in prose. Repeated fallback is the problem, not any single item.

## Output

1. Revised text.
2. If the input was already tight, say so and return it unchanged rather than performing edits.
3. If the user asks, list the dominant patterns you broke (one line each).

Don't narrate the revision process by default. Show the result.

## Source

Ruleset condensed from [Anbeeld's WRITING.md](https://github.com/Anbeeld/WRITING.md) (MIT). For always-on prose guidance, paste [ambient.md](./ambient.md) (~155 words) into your global `CLAUDE.md` or `AGENTS.md`. This skill is the on-demand audit pass for long-form work. Re-sync if upstream rules change materially.
