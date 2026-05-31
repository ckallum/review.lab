---
_origin: calsuite@dfaf5b4
name: verify
version: 1.0.0
description: |
  verify this works, prove it works, drive it, end-to-end check, before PR,
  run it and check, does the change actually work, exercise the change,
  pre-PR verification, smoke the feature.
  The pre-PR verification loop: detect what changed (frontend / backend / full-stack),
  run the app, drive the changed code path, capture proof (screenshots, log lines,
  DB rows, HTTP responses), fix-and-retry up to 3× without checking in. Adapts to
  whatever stack the downstream repo uses. Always run before opening a PR — the
  unit tests passing is necessary, not sufficient.
argument-hint: [skip]
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - Skill
  - AskUserQuestion
---

# Verify: Pre-PR end-to-end verification loop

## What this skill is for

Unit tests prove the function returns the right value for an input. Verify proves the **change actually works in the running app** — the button does the thing, the API writes the row, the log line gets emitted, the screen renders. Green CI is one signal; clicking the thing and watching it work is the other.

The flow:

```
write code → run the app → drive the changed path → did it work?
                              ↓ no                      ↓ yes
                           read logs                capture evidence
                              ↓                          ↓
                            fix code                  finish
                              ↓
                          hot reload  ─────► drive again
```

**The loop runs without you in it.** Don't pause to ask the user mid-loop. If you get stuck, surface everything you tried in one message — not five.

## Arguments

| Arg | Required | Meaning |
|---|---|---|
| `skip` | optional | Bypass the verification loop entirely — prints the skip line and stops. Use when the change has no observable runtime behavior. Equivalent to the auto-skip in "When to skip" below, but forced regardless of the diff. |

No argument runs the full loop (detect scope → run → drive → prove → tear down).

## When to skip

If `git diff origin/main --name-only` shows **only** `*.md`, `LICENSE`, `.github/`, or `*.json` config without any behavior implication, print one line and stop:

```
Verify skipped: docs/config-only change, no runtime behavior to exercise.
```

Same for the user explicitly saying "skip verify" in the arguments. Don't spin up servers for changes that can't be observed.

---

## Step 1: Detect the scope of the change

Read the diff once and classify every changed file into a bucket. The buckets drive which sub-loops actually run:

```bash
git fetch origin main >/dev/null 2>&1 || true
git diff origin/main --name-only > /tmp/verify-changed.txt
```

Bucket each file using path heuristics — adjust for the repo's actual layout (read `CLAUDE.md` and the directory tree first if anything is ambiguous):

| Bucket | Typical paths |
|---|---|
| **frontend** | `app/`, `src/components/`, `src/pages/`, `src/app/`, `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `client/`, `web/`, `frontend/` |
| **backend** | `api/`, `server/`, `routes/`, `handlers/`, `services/`, `models/`, `backend/`, `*.go`, `*.py` under server dirs, route definitions |
| **schema** | `migrations/`, `schema.sql`, `prisma/schema.prisma`, `*.dbml`, model files declaring columns |
| **infra** | `Dockerfile*`, `docker-compose*.yml`, `k8s/`, `terraform/`, `nginx.conf` |
| **docs/config** | `*.md`, `.github/`, `*.json` config files with no behavior implication |

Hold the result as `SCOPE = { frontend, backend, schema, infra, crossCutting }` where `crossCutting = frontend && backend` (the gold case — UI does a thing, backend writes a row, you prove both).

State the scope back to the user in one line so they can correct it:

```
Scope: frontend + backend (cross-cutting). Will start both servers, drive via UI,
       assert backend log line and DB row.
```

Only proceed once you're confident in the scope — if the diff is genuinely ambiguous, ask. Misdetecting "this is just a CSS change" when it actually touches state is the failure mode that makes verify useless.

---

## Step 2: Discover how to run the app

There are three places to look, in order of authority:

1. **`.claude/verify-config.json`** if it exists — the project has declared how to run itself. Use exactly what it says. See `references/config-schema.md` for the shape.
2. **`CLAUDE.md`** — project-specific instructions almost always mention the dev command.
3. **Auto-discovery** — `package.json` scripts (`dev`, `start`, `serve`), a `Makefile` (`make dev`, `make up`), `docker-compose.yml` (`docker compose up`), `manage.py runserver`, `cargo run`, `go run ./cmd/server`. See `references/discover-stack.md`.

Pick the **one-command** path. If the project has both `npm run dev` and `docker compose up`, prefer whichever the README/CLAUDE.md treats as canonical. If neither is clear, prefer the one that doesn't need credentials — Docker compose with seeded data beats `npm run dev` that crashes on missing env vars.

If you cannot find a runnable command, stop and tell the user. Verifying nothing is worse than verifying something — don't fabricate a smoke test from a guess.

---

## Step 3: Run it

**State model — read this first.** Claude Code spawns a fresh shell for every Bash tool call. Variables you set in this step (`SERVER_PID`, `LOG`, `ts`) do NOT survive into Step 4. An `EXIT trap` registered here fires the moment THIS shell call ends — killing the server right after it becomes ready, before Step 4 runs. So the skill writes state to a singleton file (`/tmp/verify-state.env`) and every subsequent step starts by sourcing it. Teardown happens explicitly in Step 7, not via trap.

### 3a. Lock check + launch

```bash
# Refuse if a previous run left state behind — explicit cleanup is safer than auto-clobber.
if [ -f /tmp/verify-state.env ]; then
  echo "Stale verify state at /tmp/verify-state.env — finish the previous run, or:"
  echo "  source /tmp/verify-state.env && [ -n \"\${VERIFY_PGID:-}\" ] && kill -- -\"\$VERIFY_PGID\" 2>/dev/null; rm -f /tmp/verify-state.env"
  exit 1
fi

VERIFY_TS=$(date +%Y-%m-%d-%H%M%S)
VERIFY_LOG=/tmp/verify-server-${VERIFY_TS}.log
VERIFY_DIR=.context/verify/${VERIFY_TS}
mkdir -p "${VERIFY_DIR}/screenshots" "${VERIFY_DIR}/responses"

# Scope docker compose to this run so the teardown doesn't tear down the user's other compose work.
# Honors the project's own COMPOSE_PROJECT_NAME if set, otherwise namespaces by timestamp.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-verify-${VERIFY_TS//[-:]/}}"

# Launch in its own process group via `setsid` so the teardown can signal the whole tree.
# `npm run dev`, `concurrently`, vite/next wrappers, Go air, etc. all spawn children — killing
# only the parent PID leaves them orphaned holding the port.
setsid bash -c '<dev-command> > "$1" 2>&1' _ "$VERIFY_LOG" &
VERIFY_PID=$!
VERIFY_PGID=$(ps -o pgid= -p "$VERIFY_PID" 2>/dev/null | tr -d ' ')

# Persist state for subsequent steps. Every later step starts with: source /tmp/verify-state.env
cat > /tmp/verify-state.env <<EOF
VERIFY_TS=${VERIFY_TS}
VERIFY_LOG=${VERIFY_LOG}
VERIFY_DIR=${VERIFY_DIR}
VERIFY_PID=${VERIFY_PID}
VERIFY_PGID=${VERIFY_PGID}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
EOF
echo "state: /tmp/verify-state.env (ts=${VERIFY_TS}, pid=${VERIFY_PID}, pgid=${VERIFY_PGID})"
```

### 3b. Wallclock-bounded ready poll

Don't just `sleep 10`, and don't loop forever — a server stuck in init (waiting on a missing DB, prompting for input) will spin until Claude's tool timeout. Cap with a wallclock deadline:

```bash
source /tmp/verify-state.env
TIMEOUT=${VERIFY_READY_TIMEOUT:-60}   # override via env or .claude/verify-config.json → dev.readySignal.timeoutSeconds
START=$(date +%s)
READY=0

until curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null | grep -qE '^[23]'; do
  if [ $(($(date +%s) - START)) -ge "$TIMEOUT" ]; then
    echo "ready timeout after ${TIMEOUT}s"
    tail -50 "$VERIFY_LOG"
    break
  fi
  if ! kill -0 "$VERIFY_PID" 2>/dev/null; then
    echo "server crashed during startup"
    tail -50 "$VERIFY_LOG"
    break
  fi
  sleep 0.5
done
# Set READY only if the probe actually succeeded — a process that's still alive but
# stuck in init would otherwise false-positive past the timeout break.
if curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null | grep -qE '^[23]'; then
  READY=1
fi

if [ "$READY" != "1" ]; then
  echo "verify aborted: server never became ready — running teardown"
  [ -n "${VERIFY_PGID:-}" ] && kill -- -"$VERIFY_PGID" 2>/dev/null
  rm -f /tmp/verify-state.env
  exit 1
fi
```

Alternative ready signals (use whichever fits the stack):
- A log line: `until grep -q "Listening on" "$VERIFY_LOG"; do sleep 0.5; done`
- A health endpoint: `curl -fsS http://localhost:3000/health`
- A Docker healthcheck: `docker compose ps --format json | jq -e 'all(.Health == "healthy")'`

**If startup fails repeatedly across attempts**, read the log, fix the cause (missing env var, port conflict, broken migration), retry. Cap at 3 attempts — past that, the problem is outside verify's scope.

---

## Step 4: Drive it

This is where the loop actually proves something. The driving technique depends on the scope:

### Frontend or cross-cutting → use a browser

Pick the available browser tool in this order:
1. `agent-browser` (CLI — same one `/qa` uses; install with `npm install -g agent-browser` if missing)
2. `mcp__Claude_Preview__preview_*` (MCP — if the project is wired for it)
3. `mcp__playwright__playwright_*` (MCP — if Playwright is installed in the project)

Full driving recipes live in `references/frontend-recipes.md`. The shape is always:

```
1. Take a "before" screenshot of the page you're about to interact with
2. Perform the user action the change enables (click the button, fill the form, navigate the route)
3. Take an "after" screenshot
4. Inspect the snapshot/console for errors
```

Use **dummy auth** if the app has one — most dev environments accept a header or query param. Don't sit in front of a login screen. If you don't know the bypass, check `references/frontend-recipes.md § "Unblock auth"` for the common patterns, or look in `.claude/verify-config.json`.

### Backend-only → `curl` the route

```bash
curl -fsS -X POST http://localhost:3000/api/widgets \
  -H 'Content-Type: application/json' \
  -d '{"name": "verify-test", "color": "red"}' \
  | tee /tmp/verify-response.json
```

Patterns for auth headers, multipart, streaming, etc. live in `references/backend-recipes.md`.

### Schema-only → run the migration and inspect

Substitute the placeholders against `.claude/verify-config.json` or what `references/discover-stack.md` discovered — these are templates, not runnable commands:

```bash
<migrate-up-command>                # e.g. `npx prisma migrate dev`, `make migrate`, `python manage.py migrate`
<db-shell> -c "\d <table>" > /tmp/verify-schema.txt   # e.g. `psql -h localhost -U dev appdev`
# Or for Prisma: npx prisma db pull && git diff prisma/schema.prisma
```

The proof for a schema change is: migration ran without error AND the resulting schema matches the migration's intent. Don't skip the inspection — a migration that runs but doesn't actually create the column is a real failure mode.

---

## Step 5: Prove it

Driving is not enough. You need **artefacts that a reviewer (or you, next week) can look at and believe**. The four classes:

| Class | What to capture |
|---|---|
| **Screenshot** | Before + after of the UI change. Saved as PNG, referenced from the summary. |
| **Log evidence** | The line(s) that prove the backend handler ran. `source /tmp/verify-state.env && grep -A2 "<expected-marker>" "$VERIFY_LOG" > "${VERIFY_DIR}/logs.txt"` |
| **DB evidence** | The row(s) the action produced. `SELECT * FROM widgets WHERE name = 'verify-test'` saved to disk. |
| **HTTP evidence** | The response body matches what the change promised. Diff against an expected shape. |

**For cross-cutting changes, capture ALL of these.** That's what makes a cross-cutting change verified instead of "the button looks right and I hope the API call landed." The DB row is the receipt.

If the backend doesn't emit a log line at the path you're verifying, **add one as part of this PR** (see `references/backend-recipes.md § "Adding log lines"` for placement and language examples). Don't treat instrumentation as out-of-scope cleanup — it's load-bearing for verifiability.

Save all evidence to:

```
.context/verify/<YYYY-MM-DD-HHMMSS>/
├── summary.md          # what was verified, scope, pass/fail, links to artefacts
├── screenshots/
│   ├── before-*.png
│   └── after-*.png
├── logs.txt            # grepped excerpts, not the full server log
├── db.txt              # SQL queries + their results
└── responses/          # any curl outputs worth keeping
```

The `summary.md` should be readable in 30 seconds. Until `/ship` learns to link it automatically, paste the path into the PR body yourself so a reviewer doesn't have to take your word for it.

---

## Step 6: The fix loop

If proof fails — wrong screenshot, missing log line, HTTP 500, DB row absent — **do not restart the server and try again**. That's the user-in-the-loop antipattern.

Read the actual error first:

```bash
source /tmp/verify-state.env
tail -100 "$VERIFY_LOG"
# Or for browser console errors:
agent-browser --session verify snapshot | grep -i -E '(error|warning|exception)'
```

Identify the specific cause from the specific error. Apply a targeted fix to the code. Most dev servers hot-reload — you don't need to restart unless you changed config, installed a dep, or the framework requires it (Go binaries, Rust binaries). Then re-run Step 4 against the same dev server.

**Cap at 3 fix attempts.** Enforce by logging every attempt — drift past 3 becomes visible in the artifact instead of buried in scrollback. Append one line per attempt to `${VERIFY_DIR}/attempts.txt` before re-running Step 4:

```bash
source /tmp/verify-state.env
echo "$(date -u +%FT%TZ) attempt-N: <one-line: what you tried this round>" >> "${VERIFY_DIR}/attempts.txt"
```

`summary.md` (written in Step 7) embeds `attempts.txt` so reviewers can see the fix path the verify took. If three targeted fixes don't get you to green, the problem is bigger than the loop can handle. Surface:

1. What you were trying to verify (the action, the expected proof)
2. What actually happened on each attempt (the error / wrong proof)
3. What you tried each time and why it didn't fix it
4. Links to the saved screenshots and log excerpts

Then either invoke `/debug` (it's built for exactly this systematic-investigation case) or hand back to the user with the full evidence. Don't keep looping silently — three rounds is the budget.

---

## Step 7: Tear down and write the summary

When proof is captured, run an **explicit teardown** — no EXIT trap, because the trap from Step 3 would have fired long ago (the launching shell exited at the end of that Bash tool call).

```bash
source /tmp/verify-state.env

# Kill the process group, not just the parent PID — npm/concurrently/vite/next wrappers
# spawn children that would otherwise leak and hold the port.
[ -n "${VERIFY_PGID:-}" ] && kill -- -"$VERIFY_PGID" 2>/dev/null

# Only down compose services this run brought up (scoped via COMPOSE_PROJECT_NAME in Step 3).
# Leaves the user's other compose services untouched.
if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && command -v docker >/dev/null 2>&1; then
  docker compose -p "$COMPOSE_PROJECT_NAME" down --remove-orphans 2>/dev/null || true
fi

# Custom teardown from .claude/verify-config.json — only if declared.
if [ -f .claude/verify-config.json ]; then
  td=$(jq -r '.teardown // empty' .claude/verify-config.json 2>/dev/null)
  [ -n "$td" ] && bash -c "$td" || true
fi

# Release the lock so the next verify can start.
rm -f /tmp/verify-state.env
```

Write `summary.md` with: scope detected, commands run, what was proven, links to evidence files, and `attempts.txt` if the fix loop ran. Reuse `$VERIFY_TS` and `$VERIFY_DIR` from the state file so the dir name and final message stay in sync. Output the summary path so the user (and a future `/ship` integration) can find it:

```
Verify passed. Evidence: ${VERIFY_DIR}/summary.md   # e.g. .context/verify/2026-05-29-141203/summary.md
```

---

## Cannot-verify cases

Some changes genuinely can't be exercised from a local dev environment:

- A code path only triggered by a prod webhook
- A cron job that runs daily
- A migration that needs production-shaped data
- A change behind a feature flag that's off in dev
- A third-party integration with no sandbox

For these, **do not pretend to verify**. Output explicitly:

```
Cannot verify locally: <one-line reason>.

To verify manually, do:
  1. <concrete step>
  2. <concrete step>

Recommend opening the PR with this caveat in the body.
```

Honesty here protects everyone downstream. A false "verified" is worse than no verify at all because reviewers stop looking.

---

## Stack adaptability

Calsuite ships this skill to every target in `config/targets.json`, each with a different stack. The skill stays general by:

1. **Detecting** the stack rather than assuming it (Step 1, Step 2).
2. **Reading per-project config** if the repo has `.claude/verify-config.json` — see `references/config-schema.md` for the schema. Projects can declare their dev command, ports, log paths, DB shell, auth bypass, and seed script.
3. **Pushing stack-specific patterns into reference files** — so the main skill stays under 400 lines and the recipes can grow without bloating context:
   - `references/discover-stack.md` — how to sniff what's running
   - `references/frontend-recipes.md` — Playwright / agent-browser / Claude Preview patterns, auth bypass, seed scripts
   - `references/backend-recipes.md` — curl patterns, log grep patterns, DB query patterns, common log-line conventions
   - `references/config-schema.md` — `.claude/verify-config.json` shape and examples

Read only the reference files the scope requires. Backend-only change? You don't need `frontend-recipes.md`.

---

## How this integrates with `/ship`

`/ship` Step 3 runs the project's unit/integration test suite. That's necessary but not sufficient — green tests + an unverified UI flow is how regressions ship.

Run `/verify` **before** `/ship`. The two skills compose:
- `/verify` proves the change works against a running app and saves evidence to `.context/verify/<ts>/summary.md`.
- `/ship` runs unit tests, simplifies, reviews, and opens the PR.

Until the integration lands, paste the `summary.md` path into the PR body yourself — `/ship` does not yet pick it up automatically. If you forget to run `/verify` first, `/ship` will not error, but the PR is weaker without the evidence. Treat them as a two-step ritual.

---

## Important rules

- **The loop runs without the user.** Don't pause for confirmation between steps. Surface only when stuck after 3 fix attempts, or when "cannot verify" applies.
- **Always capture evidence.** Screenshots / logs / DB rows. If you didn't save it, you didn't verify it.
- **Always tear down processes explicitly in Step 7.** A leaked dev server eats the next session's port. Don't use a `trap ... EXIT` — it fires when the launching Bash call ends, killing the server before Step 4 runs.
- **Add log lines if the path is opaque.** Instrumenting the change is part of verifying it, not separate cleanup.
- **Never claim verified when you didn't.** Use the "cannot verify" template instead. False confidence is the worst output.
- **Cap fix attempts at 3.** Past that, hand off to `/debug` or the user. Looping silently is the worst form of stuck.
- **Read the diff before deciding scope.** Misjudging frontend-only when it's actually cross-cutting is the failure mode that makes verify useless.

## Gotchas

- **Hot reload is your friend.** Most dev servers reload on file save — you don't need to restart for code edits. Restart only for: env var changes, deps installed, framework binaries (Go/Rust), config files the server reads at boot.
- **Auth bypass varies.** Some apps accept `X-Dev-User: foo@bar.com`, some need a real session, some have a `/dev/login` route. Check `references/frontend-recipes.md` or ask the user once and consider adding to `.claude/verify-config.json` for next time.
- **Run state lives at `/tmp/verify-state.env`** because Claude Code spawns a fresh shell per Bash tool call — variables and `trap`s from Step 3 don't survive into Step 4. Every step after Step 3 starts with `source /tmp/verify-state.env`. Step 7 explicitly tears down and removes the file. If a previous run crashed mid-loop, manually run the snippet printed by Step 3a's lock check.
- **`docker compose down` between runs** if you used Docker — orphan containers hold ports.
- **Screenshots are evidence, not decoration.** If `agent-browser screenshot` fails, retry once before giving up. The screenshot is half the proof.
- **The DB query is the receipt for write paths.** A successful HTTP 200 doesn't prove the row landed — it proves the handler returned. Always go one level deeper for writes.
