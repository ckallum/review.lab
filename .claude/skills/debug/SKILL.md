---
_origin: calsuite@2a7c883
name: debug
version: 1.0.0
description: |
  debug this, fix this bug, why is this failing, investigate error, trace the issue,
  something is broken, test failure, systematic debugging, diagnose, root cause.
  Four-phase systematic debugging built around a fast, deterministic feedback loop:
  Phase 1 build the loop, Phase 2 analyze patterns, Phase 3 test hypotheses, Phase 4 implement fix.
  The feedback loop IS the skill — every later phase just consumes its signal.
  Parallel investigation for independent failures.
argument-hint: [error-description]
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# Systematic Debugging

Four mandatory phases. Do not skip ahead to fixing — understand first.

## Domain awareness (before Phase 1)

If the repo has a `CONTEXT.md` (or a `CONTEXT-MAP.md` pointing to per-module `CONTEXT.md` files), read it for the area you're debugging — getting the right mental model of the modules in play often shortens Phase 1 dramatically. If `docs/adr/` exists and an ADR covers the area, read it: many "weird" behaviors are deliberate decisions an ADR explains, and the bug is somewhere else.

> **Phase 1 IS the skill.** A fast, deterministic, agent-runnable pass/fail signal for the bug is the difference between debugging and guessing. Everything in Phases 2–4 just consumes that signal. Spend disproportionate effort here. Be aggressive. Be creative. Refuse to give up.

## Phase 1: Build a feedback loop

### Read the error carefully

Don't skim. Read the full error output, stack trace, and surrounding logs. Extract:
- **What** failed (exact error message)
- **Where** it failed (file, line, function)
- **When** it started failing (recent change? always broken?)

### Construct a loop — try these in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive the loop with a script and capture output — keep the loop structured even when it's not headless.

```bash
# Run the failing command/test
<reproduce command>
```

### Iterate on the loop itself

Treat the loop as a product. Once you have *a* loop, ask:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelize, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### Check recent changes (still relevant)

```bash
git log --oneline -10
git diff HEAD~3 --stat
```

Did a recent commit touch the failing area? Use that to inform Phase 3 hypothesis ranking, not as a substitute for the loop.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesize without a loop — guessing without a signal wastes more time than building the loop ever would.

### Gather evidence in multi-component systems

If the failure spans multiple components, trace the data flow:
1. Where does the input enter the system?
2. What transformations happen?
3. Where does the output diverge from expected?

Add temporary logging if needed to narrow down the boundary — but tag every log with a unique prefix (e.g. `[DEBUG-a4f2]`) so cleanup at the end is a single grep.

**Do not proceed to Phase 2 until you have a loop you believe in.**

## Phase 2: Pattern Analysis

### Find a working example

Find code that does something similar and works:

```bash
# Search for similar patterns
```

Use Grep/Glob to find analogous code paths, test cases, or previous implementations.

### Compare against the reference

What's different between the working version and the broken one? Common differences:
- Missing null/undefined check
- Different argument order
- Missing await/async
- Wrong import path
- Stale cache or state
- Environment variable missing

### Understand the dependency chain

Trace what the broken code depends on:
- What does it import?
- What state does it expect?
- What runs before it?
- What external services does it call?

## Phase 3: Hypothesis and Test

### Form a single hypothesis

Based on evidence from Phases 1-2, state one clear hypothesis:
> "The failure occurs because X, which causes Y, resulting in Z."

### Test minimally

Make the smallest possible change to test your hypothesis. If the hypothesis is right, the minimal fix should resolve the issue. If wrong, revert and form a new hypothesis.

**Do NOT:**
- Change multiple things at once
- "Try random fixes and see what sticks"
- Add workarounds without understanding the root cause

### Verify before continuing

Run the reproduction again. If the fix works, proceed to Phase 4. If not, go back to Phase 2 with new information.

## Phase 4: Implement the Fix

### Create a failing test case

Before applying the fix permanently, write a test that captures the bug:

```
# Test that reproduces the exact failure
```

This ensures the bug doesn't regress.

### Implement a single fix

Apply the minimal fix. One change, one commit. Don't bundle unrelated cleanup.

### Verify comprehensively

1. The new test passes
2. The original failure no longer reproduces
3. Existing tests still pass
4. No regressions introduced

### If 3+ fix attempts have failed

Stop. Question the architecture:
- Is the mental model of the system wrong?
- Is there a deeper design issue?
- Present findings to the user via AskUserQuestion with options:
  A) Continue debugging with a different approach
  B) Escalate — describe the full investigation so far

## Parallel Investigation Mode

When you encounter **2+ independent failures** (different root causes, different components):

Dispatch one agent per independent failure domain:

```text
prompt: "Investigate this failure:
<error output>
<relevant file paths>

Follow systematic debugging phases 1-3. Report: root cause hypothesis, evidence, and proposed minimal fix. Do NOT apply the fix."
description: "Debug: <failure description>"
```

Rules for parallel dispatch:
- Only parallelize genuinely independent failures (different files, different subsystems)
- If failures might be related (same component, cascading), investigate sequentially
- Each agent investigates but does NOT fix — collect all root causes first, then apply fixes in the right order

## Red Flags — You're Going Wrong If:

- **Changing code without understanding why it's broken.** Stop. Go back to Phase 1.
- **"It works now but I don't know why."** That's not fixed. Find the actual cause.
- **Adding a try/catch to suppress the error.** That's hiding, not fixing.
- **The fix is longer than 20 lines.** Probably over-engineering. Simpler fix likely exists.
- **You're debugging for 15+ minutes without new evidence.** Step back, gather more data, or ask the user for context.

## Gotchas

- **Build a loop FIRST.** Without a fast pass/fail signal you cannot verify any fix. Don't guess. Reproduction is item 1 of the 10-tactic ladder, not the headline — the headline is "any deterministic signal".
- **Check the test, not just the code.** Sometimes the test itself is wrong — asserting the wrong thing, using stale fixtures, or having a race condition.
- **Environment differences matter.** CI vs local, Node version, env vars, database state. Ask if the failure is environment-specific.
- **Flaky tests need special treatment.** If it fails intermittently, it's likely timing, ordering, or shared state. Run it 5x in a row to confirm.
- **Don't trust error messages literally.** "Cannot find module X" might mean X exists but has a syntax error. "Connection refused" might mean wrong port, not server down. Verify the actual state.
