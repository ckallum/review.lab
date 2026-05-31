---
_origin: calsuite@dfaf5b4
---

# Frontend verification recipes

Patterns for driving the browser and capturing UI evidence. The goal is always the same: take a screenshot before, perform the user action the change enables, take a screenshot after, check the console.

## Picking a browser tool

In order of preference:

1. **`agent-browser`** (CLI) — same one `/qa` uses. Install with `npm install -g agent-browser && agent-browser install`. Stable session model, good for the verify loop.
2. **`mcp__Claude_Preview__preview_*`** — Anthropic-internal MCP, lighter-weight, good for ephemeral previews.
3. **`mcp__playwright__playwright_*`** — if the project already has Playwright installed.

Check which is available:

```bash
which agent-browser 2>/dev/null && echo "use agent-browser"
# Otherwise check the MCP tool list in the system reminder
```

The rest of this file uses `agent-browser` syntax. Translate one-to-one for the MCP variants — the operations are the same (open, snapshot, click, fill, screenshot).

## Session isolation

Always pass `--session verify` so you don't collide with `/qa` or other browser users:

```bash
agent-browser --session verify open http://localhost:3000
```

## The core loop

```bash
# Source state from Step 3 — VERIFY_DIR points at .context/verify/<ts>/, screenshots/ already exists
source /tmp/verify-state.env

# 1. Open the page that contains the change
agent-browser --session verify open http://localhost:3000/signup

# 2. Before screenshot — VERIFY_DIR/screenshots/ was created in Step 3a. If you bypass Step 3
#    (e.g. testing the recipe standalone), run `mkdir -p "${VERIFY_DIR}/screenshots"` first —
#    agent-browser does not auto-create parents and the screenshot will fail silently.
agent-browser --session verify screenshot "${VERIFY_DIR}/screenshots/before-signup.png"

# 3. Snapshot to get @ref IDs
agent-browser --session verify snapshot

# 4. Drive the action (use the @refs from the snapshot)
agent-browser --session verify fill @email "verify@test.local"
agent-browser --session verify fill @password "test1234"
agent-browser --session verify click @submit

# 5. Wait for the response
agent-browser --session verify wait 2000

# 6. After screenshot
agent-browser --session verify screenshot "${VERIFY_DIR}/screenshots/after-signup.png"

# 7. Look for errors — hard errors fail the verify; warnings are surfaced but non-blocking
#    (see "Console error handling" below for why warnings alone don't fail).
agent-browser --session verify snapshot | grep -i -E '(error|exception|failed)'
agent-browser --session verify snapshot | grep -i 'warning' || true
```

## Asserting success

A screenshot alone is not assertion — eyeballing pixels is the user's job, not yours. After the action, check that the **observable success signal** appeared:

- URL changed to the expected next page: `agent-browser --session verify url`
- Success text visible: `agent-browser --session verify find "Welcome"`
- A specific element exists: `agent-browser --session verify snapshot | grep -F "@dashboard-nav"`

For form submissions, the success signal is typically a redirect or a success message. For data display changes, the success signal is the new content rendering.

## Unblock auth

The single biggest blocker for the verify loop is the login screen. The dev environment should let you in trivially.

### Common bypass patterns

| Pattern | How to use |
|---|---|
| **Magic header** | Server accepts `X-Dev-User: foo@bar.com`. Set via browser tool or curl. |
| **Dev login route** | `/dev/login?email=foo@bar.com` returns a session cookie. Open it before the main URL. |
| **Test fixture session** | A pre-seeded user with known credentials. Fill and submit once, the cookie persists for the session. |
| **Env-flag skip** | `AUTH_REQUIRED=false` in dev — no auth at all. Best for verify if available. |

### Adding a bypass

If the app has no dev-friendly auth and you're verifying repeatedly, **add one in this PR**. A small middleware that mints a user from a request header makes every future verify trivial:

```js
// Gate on a POSITIVE opt-in env — never NODE_ENV alone. Production has been known
// to ship with NODE_ENV unset, defaulted, or shadowed by a deploy tool, which
// would silently disable auth. ALLOW_DEV_AUTH must be set to "1" explicitly
// (default unset = fail closed).
if (process.env.ALLOW_DEV_AUTH === '1' && req.headers['x-dev-user']) {
  req.user = { id: 'verify', email: String(req.headers['x-dev-user']) };
}
```

Treat it as enabling verification, not unrelated work. The `ALLOW_DEV_AUTH=1` env var lives only in your local `.env` / dev compose file — never in any deploy config.

### Documenting the bypass

Once you know the bypass, add it to `.claude/verify-config.json`:

```json
{
  "auth": {
    "type": "header",
    "header": "X-Dev-User",
    "value": "verify@test.local"
  }
}
```

So the next verify run picks it up automatically.

## Seed scripts for known state

If the change is "the dashboard shows the user's recent invoices", you need invoices in the DB. Two options:

1. **Project has a seed script** — run it: `npm run seed`, `make seed`, `python manage.py loaddata fixtures.json`.
2. **No seed script** — create the data via API or DB shell as part of the verify run:

```bash
# Via API (preferred — exercises real code paths). -fsS is load-bearing: -f makes curl exit
# non-zero on 4xx/5xx, -s quiets progress, -S still shows errors. Without -f, a 500 looks like
# success to the shell. Content-Type is required by most JSON APIs (otherwise 415).
curl -fsS -X POST http://localhost:3000/api/invoices \
  -H 'Content-Type: application/json' \
  -H 'X-Dev-User: verify@test.local' \
  -d '{"amount": 1000, "status": "pending"}'

# Via DB shell (fallback)
psql -h localhost -U dev appdev -c "INSERT INTO invoices ..."
```

If the project lacks a seed script entirely, propose adding one — it's the same cost-benefit as adding auth bypass.

## Common dev-server quirks

- **Vite over-eagerly hot-reloads** — the page may reload mid-action. Add a `wait 500` after the action to settle.
- **Next.js first-page-render is slow** — the *first* navigation after server start can take 5-10s. Add a long wait after `open` for the first interaction.
- **React strict mode double-renders** — log lines may appear twice in dev. Don't treat doubled logs as a bug unless they also double in prod.
- **CORS in dev** — if your verify script hits the API directly, the dev server may block it. Either drive via the UI (no CORS), or run the API server with permissive CORS in dev.

## When you need real auth

Some flows can't be bypassed (OAuth callbacks, magic links, SAML). For these:

1. Pre-seed a session cookie via a test fixture and the API.
2. Or, document explicitly that this flow is in the "cannot verify locally" bucket.

Don't try to drive the OAuth provider's login screen — it's brittle and not what verify is for.

## Console error handling

After each action, snapshot and grep for errors. Treat console output as a real signal:

- **Red errors** — almost always a real bug. Fix or surface.
- **Yellow warnings** — read them; many are noise (React dev warnings, peer dep mismatches). Don't fail the verify on warnings alone unless they relate to the change.
- **404s on assets** — flag if they're for files the change added; ignore if they're third-party tracker fails.
