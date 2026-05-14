---
_origin: calsuite@2a7c883
---

# Ambient prose ruleset

Mini version of [Anbeeld's WRITING.md](https://github.com/Anbeeld/WRITING.md) (MIT). Paste the section below verbatim into your global `CLAUDE.md` or `AGENTS.md` for always-on prose guidance. The full audit pass lives in [SKILL.md](./SKILL.md) and runs on demand via `/humanize`.

---

## Writing prose

Applies to commit messages, PR bodies, READMEs, docs, blog posts, external copy. Not code. Skip for terse status updates and one-line comments — sterile is correct there.

When rules conflict: truth > user > genre > rules.

- Casual: prose. Technical: structure. Long-form: angle, not timeline. Straight quotes in plain text.
- Each paragraph: one concrete anchor (proper noun, number, quote, detail). `many` / `various` / `essentially` don't count. Don't invent milestones, narrate hidden mechanisms, or launder vague authority — attribute, soften, or cut what you can't verify.
- Plain words and verbs. Repeat ordinary words. Link with pronouns, not `furthermore` / `moreover`.
- No `keynote`, `Great question`, `I hope this helps`. Start and stop at the answer. Stance: visible where expected, neutral where expected. Don't sand mild, don't manufacture a view.
- Avoid repeated patterns: parallel lists (three items still count), concession rhythm (`not X, but Y`), X-is-that wrappers, `called` before nouns, identical paragraph arcs. Break where they dominate.
- Long-form: pick a through-line (thematic, perspective-led, single-example-led), not chronology or catalog. Include an example, pause, or double back; don't rush to conclusion.
- Cut, don't add. No fake humanity, no programmed sentence-length variation, no invented typos. Don't strip structure for style.
- Check: register, anchors, regularity, stance, over-correction. Scrutinize (fallback, not bans): `delve` / `leverage` / `seamless`, `it's important to note`, unnamed `experts`, unsupported causality.

For one-shot polish on long-form work, run `/humanize`.

Source: [Anbeeld's WRITING.md](https://github.com/Anbeeld/WRITING.md) (MIT).
