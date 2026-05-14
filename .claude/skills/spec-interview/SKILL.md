---
_origin: calsuite@2a7c883
name: spec-interview
description: Conduct an in-depth interview about a spec document to surface edge cases, tradeoffs, and non-obvious decisions, then write the final spec. Use when a SPEC.md exists and needs to be fleshed out.
disable-model-invocation: true
argument-hint: [spec-file-path]
---

Conduct an in-depth interview about a spec document, then write the final spec.

## Instructions

When this skill is invoked:

1. **Find the spec file.** If `$ARGUMENTS` is provided, use that as the file path. Otherwise, look for files matching `**/SPEC.md`, `**/spec.md`, or similar in the current project. If multiple are found or none exist, use AskUserQuestion to ask which file to use or where to create one. Read the file contents thoroughly.

2. **Interview the user.** Conduct a deep, multi-round interview using AskUserQuestion. The goal is to surface non-obvious decisions, edge cases, and tradeoffs that the spec doesn't address or is ambiguous about.

   Interview guidelines:
   - **Do NOT ask obvious questions** that the spec already answers clearly. Read the spec carefully first.
   - **Do ask about:** hidden complexity, conflicting requirements, unstated assumptions, failure modes, edge cases, scaling concerns, security implications, data model subtleties, UX micro-interactions, state management tradeoffs, migration paths, backwards compatibility, error handling strategy, performance budgets, accessibility considerations, and integration boundaries.
   - **Be specific.** Reference concrete parts of the spec. Instead of "how should errors work?", ask "when the payment webhook fails mid-checkout and the user has already seen the success screen, what should happen?"
   - **Go deep on answers.** Follow up on interesting responses. If the user says "we'll use a queue", ask about retry policy, dead letters, ordering guarantees, idempotency.
   - **Cover multiple dimensions per round.** Use multi-question AskUserQuestion calls (up to 4 questions) to keep the interview moving efficiently.
   - **Provide informed options.** When asking about tradeoffs, present concrete options with pros/cons rather than open-ended questions.

3. **Continue until complete.** Keep interviewing across multiple rounds. A thorough interview typically needs 4-8 rounds depending on spec complexity. You are done when:
   - All major architectural decisions are resolved
   - Edge cases and error flows are addressed
   - The user confirms they have nothing else to add

4. **Write the final spec.** Once the interview is complete, rewrite the spec file incorporating all decisions from the interview. The final spec should:
   - Preserve the original structure and intent
   - Integrate all interview answers as concrete decisions (not as Q&A)
   - Add new sections for topics that emerged during the interview
   - Be written as a definitive spec, not a discussion document
   - Flag any remaining open questions that weren't resolved
