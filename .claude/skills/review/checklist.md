---
_origin: calsuite@b196ace
---

# Pre-Landing Review Checklist

## Instructions

Review the `git diff origin/main` output for the issues listed below. Be specific — cite `file:line` and suggest fixes. Skip anything that's fine. Only flag real problems.

**Two-pass review:**
- **Pass 1 (CRITICAL):** Run these first. These can block shipping.
- **Pass 2 (INFORMATIONAL):** Run all remaining categories. These are included in the PR body but do not block.

**Output format:**

```text
Checklist Review: N issues (X critical, Y informational)

**CRITICAL** (blocking):
- [file:line] Problem description
  Fix: suggested fix

**INFORMATIONAL** (advisory):
- [file:line] Problem description
  Fix: suggested fix
```

If no issues found: `Checklist Review: No issues found.`

Be terse. For each issue: one line describing the problem, one line with the fix. No preamble, no summaries, no "looks good overall."

---

## Review Categories

### Cross-cutting patterns

Most of the citation-rich Pass 1 and Pass 2 bullets below are instances of three abstract shapes. Carry the principle into the scan so you can flag new instances the checklist doesn't yet list.

- **A — State surface sync.** Any logical state with two or more surfaces (in-memory + DB, source doc + parsed store, prop + live store, event payload + frontend listener, write path + read path) must have every transition touch all surfaces. A one-sided change ships green. Instances below: *Stale in-memory state after DB write* (Race Conditions), *Conditional Side Effects* (status set on one branch only), *Aggregation Source Consistency* (totals derived from different sources with different filtering), *Derive-during-render must also sync state* (React 19 State Patterns), and the *Serialize/deserialize symmetry* check in the versioned-struct pass.
- **B — Defensive-default trap.** Substituting an empty / default / `Ok(None)` for an error signal turns "something went wrong" into "nothing happened" — indistinguishable to callers, and the next write destroys the evidence. Instances below: the swallowed-error, catch-all-without-context, and empty-`catch {}` bullets under *Error Handling*; *Error state vs empty state* and *Feature flags inferred from API failure* under *React Async Patterns*; and the sentinel-value bullet under *Aggregation Source Consistency*.
- **C — Stale-reference class.** After a structural change (renamed type, new enum variant, dropped param, changed contract, deleted column), every reference to the old shape must grep to zero — including comments, specs, tests, and blame-anchored claims. Instances below: the stale-comment and "all X converted" bullets under *Dead Code & Consistency*, the error-string-as-query-filter bullet under *Magic Numbers & String Coupling*, *Sibling Helper Drift*, and *Test Mock Staleness*.

Not unified here: the ordering / atomicity family (TOCTOU re-reads under *SQL & Data Safety*, atomic conditional updates under *Race Conditions & Concurrency*) is a sibling concern. Same goal as A — consistency across surfaces — but the mechanism is sequencing and rollback, not symmetric writes. Treat the concrete bullets as load-bearing rather than rolling them up.

### Pass 1 — CRITICAL

#### SQL & Data Safety
- String interpolation or concatenation in SQL queries — use parameterized queries / prepared statements
- TOCTOU races: check-then-write patterns that should be atomic (use conditional updates, upserts, or transactions)
- Bulk operations bypassing validation layers (ORM `.update_all`, raw SQL updates, etc.)
- N+1 queries: missing eager loading for associations used in loops
- **LIKE metacharacter injection**: User-supplied strings used in `LIKE` predicates must escape `%` and `_` (typically as `\%` and `\_`) before interpolation. Folder paths, search terms, and any user input are common sources of unescaped wildcards.

#### Race Conditions & Concurrency
- Read-check-write without uniqueness constraint or conflict handling (`ON CONFLICT`, `rescue`/`catch` duplicate key)
- Find-or-create on columns without unique DB index — concurrent calls can create duplicates
- Status transitions without atomic conditional updates — concurrent updates can skip or double-apply
- User-controlled data rendered as raw HTML without sanitization (XSS)
- **Stale in-memory state after DB write**: After any `UPDATE` that modifies a field used later in the same function, verify the local variable is updated or re-read from the DB. Common with counters, status fields, and any mutable value whose post-write value is consumed downstream.

#### LLM Output Trust Boundary
- LLM-generated values (emails, URLs, names) written to DB or passed to external services without format validation. Add lightweight guards (regex, `URL.parse`, `.trim()`) before persisting.
- Structured tool output (arrays, objects) accepted without type/shape checks before database writes.

#### Auth & Security Boundaries
- Missing authentication checks on new endpoints or routes
- Missing authorization / tenant scope enforcement on data access
- Secrets, API keys, tokens, or credentials committed in code or config (not in .env / secrets manager)
- Unsafe deserialization, dynamic code evaluation (`eval`-family), or code injection vectors
- Path traversal in file operations using user-supplied input
- User-supplied values passed to `querySelector` / `querySelectorAll` without regex validation — selector-based DOM injection risk. Validate against an allowlist or escape CSS syntax before interpolation.

#### React Lifecycle & Cleanup
- `setTimeout` / `setInterval` inside `useEffect` without a cleanup function in the return — causes state updates on unmounted components and leaked timers
- Polling `useEffect` that starts unconditionally without checking `document.hidden` — wastes resources on background tabs and can hammer APIs from hidden windows
- `useSearchParams()` used without a surrounding `<Suspense>` boundary — required by Next.js App Router; build will fail or hydration will mismatch

### Pass 2 — INFORMATIONAL

#### React 19 State Patterns
- **Derive-during-render must also sync state**: When a component computes an `effectiveX` during render to mask a stale `x` state (e.g., "filter falls back to a default if the selected option disappears from the props"), the derivation alone hides the bug — it doesn't fix it. The underlying `x` state stays stale and can snap back to the displayed-but-not-stored value when that value reappears in the props. Look for the pattern `const effectiveX = condition ? fallback : x` and check whether `setX(effectiveX)` is also called (via prev-prop tracking) so the stored state matches what the user sees.
- **`useEffect(() => setX(...), [prop])` is forbidden**: The `react-hooks/set-state-in-effect` rule catches this, but new instances can slip through. When state needs to reset because a prop changed, use prev-prop tracking with `useState` and adjust during render — not an effect.

#### React Async Patterns
- **`setInterval` with an async callback**: Causes overlapping fetches when responses are slow. Use a recursive `setTimeout` that schedules the next poll only after the current fetch completes.
- **Polling `useEffect` dependency array**: If the dep array includes state updated by the polling callback, the effect re-runs every poll cycle (tearing down and recreating the polling timer). Use refs for data accessed inside the callback; derive a stable boolean for the dep.
- **Error state vs empty state**: Catch blocks that return `null` / `[]` make API failures indistinguishable from "no data". Use a separate error state with a user-visible banner and retry action.
- **Feature flags inferred from API failure**: `res.ok` treats every network error as "feature disabled". Check for a specific status (e.g., 403) to mean disabled; surface other errors.
- **External URLs rendered as `<a href>`**: Validate both the protocol AND the host domain before rendering. `startsWith("https://")` is insufficient — whitelist expected hosts for any URL that came from user or third-party data.
- **Server component self-fetch**: Server components fetching their own API routes over HTTP is an anti-pattern. Use direct DB / service-layer calls instead.

#### Conditional Side Effects
- Code paths that branch on a condition but forget to apply a side effect on one branch (e.g., status updated but related field only set in one branch — creating inconsistent state)
- Log messages that claim an action happened but the action was conditionally skipped
- State variables (counters, flags, accumulators) added for a feature lifecycle — verify they reset on deactivation/reactivation, not just on success

#### Aggregation Source Consistency
- Related totals (e.g., `sufficientCount`, `partialCount`, `missingCount`) computed from different sources — some via `array.reduce` over a child collection, others via `parent.filter`. If the child collection is filtered (e.g., excluding orphans) but `parent.filter` includes everything, the totals won't sum to `parent.length` and any derived score will drift on the filtered-out rows. When reviewing a diff, identify variables that should sum to a total and verify they all derive from the same source with the same filtering.
- Sentinel values returned from extraction/parse helpers that callers treat as data — e.g., `return "[FAILED]"` from a function whose return is then embedded into a vector index or passed to an LLM. Always return `""` or `null` on failure so callers can route to a fallback.

#### Sibling Helper Drift
- When two helpers in different modules wrap the same upstream library, they must agree on error handling (try/catch + null/empty return), output cap, and edge cases. Drift means the same malformed input fails differently in two pipelines and is hard to diagnose. When a PR adds a new branch or error path to one, audit the other.

#### Magic Numbers & String Coupling
- Bare numeric literals used in multiple files — should be named constants
- Error message strings used as query filters elsewhere (grep for the string — is anything matching on it?)

#### Dead Code & Consistency
- Variables assigned but never read
- Unused imports or unreachable code paths
- Comments/docstrings that describe old behavior after the code changed
- Version mismatch between PR and VERSION/CHANGELOG files
- Mechanical refactors claiming "all X converted" — grep the full file for the old pattern to verify completeness

#### LLM Prompt Issues
- 0-indexed lists in prompts (LLMs reliably return 1-indexed)
- Prompt text listing available tools/capabilities that don't match what's actually wired up
- Word/token limits stated in multiple places that could drift

#### Test Gaps
- Negative-path tests that assert type/status but not side effects (fields populated? callbacks fired?)
- Assertions on string content without checking format (e.g., asserting title present but not URL format)
- Missing assertions that a code path should explicitly NOT call an external service
- Security enforcement features (blocking, rate limiting, auth) without integration tests verifying enforcement
- Changed function return type or error contract (e.g., `Ok(None)` → `Err`) — verify at least one test exercises the new error/failure path

#### Error Handling
- Missing error handling at system boundaries (API routes, background jobs, external service calls)
- Generic catch-all without logging or re-raising with context
- Swallowed errors that fail silently with no user-visible feedback
- Empty `catch {}` blocks that hide failures — at minimum log the error with enough context to diagnose
- **Redirect-on-error routes without logging**: Any route that redirects with a query-param error code (e.g., `?error=exchange_failed`) must log at every error exit with the step name, HTTP status, and upstream error body (redacted). Common offenders: OAuth callbacks, webhook handlers, and payment-return routes. Without logging, failures are undiagnosable without redeploying.

#### Test Mock Staleness
- Imports in the module under test changed, but the test's `vi.mock()` / `jest.mock()` targets still reference the old module path — causes "Cannot find package" errors at test time
- New table / module / export imported by the subject but not added to the test's mock factory — causes "No export defined on mock" at runtime

#### Debug Artifacts
- `console.log`, `print()`, `debugger`, `binding.pry`, `breakpoint()`, `pp`, `dump()` left in production code
- `TODO`/`FIXME`/`HACK` comments introduced in this diff without a tracking issue

#### Crypto & Entropy
- Truncation of data instead of hashing (less entropy, easier collisions)
- Non-cryptographic random (`Math.random`, `rand()`, `random.random`) for security-sensitive values — use cryptographic RNG
- Non-constant-time comparisons (`==`) on secrets or tokens — vulnerable to timing attacks

#### Time Window Safety
- Date-key lookups that assume "today" covers 24h — may only see partial day depending on timezone
- Mismatched time windows between related features (one uses hourly buckets, another daily keys)

#### Type Coercion at Boundaries
- Values crossing language/serialization boundaries where type could change (numeric vs string)
- Hash/digest inputs that don't normalize types before serialization — different types produce different hashes

---

## Signal-Gated Passes

These passes only run when a cheap grep against the diff detects the corresponding signal. Skip silently if no signal fires.

### Versioned-struct pass

**Signal (run this pass only if the diff matches any of these):**
- Rust: `const\s+\w*_VERSION\b`, or a struct field declared `\s+version\s*:\s*(u\d+|i\d+)\b`
- TypeScript: `\bversion\s*:\s*number\b` on a type used in serialize/deserialize paths

**When the signal fires, check every versioned struct in the diff for:**

- **Version check on deserialize/hydrate:** does the deserialize path read `version` and branch? A missing check means a future-version payload silently loads with today's code.
- **Degraded fallback for version mismatch:** on mismatch, does the code emit a degraded event, fall back to a safe default, or refuse to hydrate? Crashing is acceptable; silently ignoring is not.
- **Serialize/deserialize symmetry:** every field on the struct must be populated in *both* directions. If a field is written but never read (or vice versa), flag it — this was the PR #173 `hydrated_from_storage` class of bug.
- **Capped arrays truncated post-deserialize:** if the struct has a `Vec<T>` or `Array` with a declared cap (e.g. `const MAX_X: usize = 100`), the deserialize path must `.truncate(cap)` after reading — stored payloads from earlier versions may exceed the cap.

**Output format:**
```
Versioned-Struct Pass: N issues
- [file:line] <StructName>.version — <specific gap>
  Fix: <concrete fix referencing the four checks>
```

If no issues, emit `Versioned-Struct Pass: clean`.

---

## Gate Classification

```text
CRITICAL (blocks shipping):           INFORMATIONAL (in PR body):
├─ SQL & Data Safety                  ├─ React 19 State Patterns
├─ Race Conditions & Concurrency      ├─ React Async Patterns
├─ LLM Output Trust Boundary          ├─ Conditional Side Effects
├─ Auth & Security Boundaries         ├─ Aggregation Source Consistency
└─ React Lifecycle & Cleanup          ├─ Sibling Helper Drift
                                      ├─ Magic Numbers & String Coupling
                                      ├─ Dead Code & Consistency
                                      ├─ LLM Prompt Issues
                                      ├─ Test Gaps
                                      ├─ Error Handling
                                      ├─ Test Mock Staleness
                                      ├─ Debug Artifacts
                                      ├─ Crypto & Entropy
                                      ├─ Time Window Safety
                                      └─ Type Coercion at Boundaries
```

---

## Suppressions — DO NOT flag these

- "X is redundant with Y" when the redundancy is harmless and aids readability
- "Add a comment explaining why this threshold/constant was chosen" — thresholds change during tuning, comments rot
- "This assertion could be tighter" when the assertion already covers the behavior
- Suggesting consistency-only changes (wrapping a value in a conditional to match how another constant is guarded)
- "Regex doesn't handle edge case X" when the input is constrained and X never occurs in practice
- "Test exercises multiple guards simultaneously" — that's fine, tests don't need to isolate every guard
- Threshold/tuning constant changes — these are tuned empirically and change constantly
- Harmless no-ops (e.g., filter on a value that's never in the collection)
- Style preferences already handled by formatters or linters
- ANYTHING already addressed in the diff you're reviewing — read the FULL diff before commenting
