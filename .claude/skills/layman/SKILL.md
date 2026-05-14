---
_origin: calsuite@2a7c883
name: layman
description: Summarise a code change in plain, non-technical language with real-life analogies and a clear flow
user-invocable: true
arguments: Optional PR number (#123), commit hash, branch, or file path. Defaults to current branch's PR, then staged/unstaged changes, then most recent commit.
---

# /layman

Explain what changed in plain English that anyone — a PM, a designer, a founder, your mum — can understand. Designed to run after `/ship` and multiple review cycles, when the full scope of a change is finalised.

## Instructions

1. **Identify the change.** Resolve the source in this order:
   - If `$ARGUMENTS` is a PR number (e.g. `#42`), fetch that PR's diff and description with `gh pr view` and `gh pr diff`.
   - If `$ARGUMENTS` is a commit hash, branch name, or file path, use that.
   - If no arguments: check if the current branch has an open PR (`gh pr view --json number,title,body`). If it does, use that PR's full diff against base.
   - If no PR exists, fall back to staged/unstaged changes, then the most recent commit.

   When using a PR, read the PR description, all commits in the PR (`git log base..HEAD`), and the full diff — this gives you the complete picture after all review rounds.

2. **Understand the change deeply.** Read the relevant code, surrounding context, and any related files so you fully grasp what happened and why. For PRs with multiple review cycles, focus on the final state — not intermediate back-and-forth.

3. **Write a summary with these sections:**

### What changed (one sentence)
A single plain-English sentence. No jargon. A non-technical person should immediately get it.

### Real-life analogy
Pick a concrete, everyday analogy that captures the essence of the change. Think: post office, restaurant kitchen, traffic lights, filing cabinets, assembly lines — whatever fits best. Extend the analogy enough to cover the key details without overcomplicating it.

### How it works (step-by-step flow)
Walk through the flow of the change as a numbered list, still in plain language. Each step should map to a real action in the code but be described in terms anyone can follow. Use the analogy from above where it helps.

### Why it matters
One or two sentences on the practical impact — what gets better, what problem goes away, what users or developers gain.

## Rules

- Zero jargon. No function names, class names, or technical terms unless absolutely unavoidable — and if you must use one, define it in parentheses immediately.
- Keep it concise. The whole summary should fit comfortably in a Slack message.
- Prefer concrete over abstract. "The app now remembers your place in a list" beats "State persistence was added to the pagination module."
- Match the analogy to the change's complexity — don't use a factory assembly line to explain a one-line fix.
