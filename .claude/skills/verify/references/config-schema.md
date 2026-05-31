---
_origin: calsuite@dfaf5b4
---

# `.claude/verify-config.json` schema

Optional per-project config that tells `/verify` how to run the app, where logs go, how to bypass auth, and how to query the DB. Without this file, the skill auto-discovers from `package.json` / `Makefile` / `CLAUDE.md`. With it, the skill skips guessing and uses what the project declares.

Recommended once the same project has been verified more than twice — auto-discovery is fine for one-off, but a declared config is faster and more reliable on repeat runs.

## Full schema (all fields optional)

```json
{
  "scope": {
    "frontendPaths": ["src/components/**", "src/pages/**", "app/**"],
    "backendPaths": ["api/**", "server/**", "src/server/**"],
    "schemaPaths": ["migrations/**", "prisma/schema.prisma"]
  },
  "dev": {
    "command": "docker compose up -d && npm run dev",
    "readySignal": {
      "type": "http",
      "url": "http://localhost:3000/health",
      "expectStatus": 200,
      "timeoutSeconds": 60
    },
    "frontend": {
      "command": "npm run dev:frontend",
      "port": 3000,
      "readyPath": "/"
    },
    "backend": {
      "command": "npm run dev:backend",
      "port": 8080,
      "readyPath": "/api/health"
    }
  },
  "teardown": "docker compose down",
  "logs": {
    "path": "/tmp/verify-server.log",
    "format": "json"
  },
  "db": {
    "shellCommand": "psql -h localhost -U dev appdev",
    "queryFlag": "-c"
  },
  "auth": {
    "type": "header",
    "header": "X-Dev-User",
    "value": "verify@test.local",
    "loginUrl": "http://localhost:3000/dev/login?email=verify@test.local"
  },
  "seed": "npm run seed:verify",
  "evidenceDir": ".context/verify"
}
```

## Field reference

### `scope`

Override the default path-bucketing heuristics if the repo has an unusual layout. Each array is a list of globs.

If omitted, the skill uses the defaults in `SKILL.md § "Step 1: Detect the scope"`.

### `dev`

How to start the app. Two modes:

**Single-command mode** (typical):
```json
"dev": { "command": "npm run dev", "readySignal": { ... } }
```

**Split mode** (frontend + backend run separately, e.g. classic SPA + API):
```json
"dev": {
  "frontend": { "command": "...", "port": 3000, "readyPath": "/" },
  "backend":  { "command": "...", "port": 8080, "readyPath": "/health" }
}
```

In split mode, the skill only starts what the scope needs — backend-only change skips the frontend server.

### `dev.readySignal`

Three types:

```json
{ "type": "http", "url": "http://localhost:3000/health", "expectStatus": 200, "timeoutSeconds": 60 }
{ "type": "log",  "pattern": "Listening on", "timeoutSeconds": 30 }
{ "type": "port", "port": 3000, "timeoutSeconds": 30 }
```

The skill polls until the signal arrives or the timeout hits. Without this field, it defaults to polling port + log for `(ready|listening|started)`.

### `teardown`

A command to run during explicit Step 7 teardown. Typical: `docker compose down`, or a custom cleanup script. The skill always kills the dev-server process group — `teardown` is for sidecars.

### `logs`

Where the dev server writes structured logs. The skill greps this file for proof markers.

```json
"logs": { "path": "logs/dev.log", "format": "json" }
```

`format: "json"` enables `jq`-based queries; `format: "text"` falls back to plain `grep`.

If the dev server logs to stdout and you want to capture it, point `logs.path` at `/tmp/verify-server.log` and the skill will redirect stdout/stderr there when starting.

### `db`

How to run a query for the DB-row receipt. The skill assembles:

```bash
<shellCommand> <queryFlag> "<sql>"
```

For Postgres: `psql -h localhost -U dev appdev -c "SELECT ..."` →
```json
"db": { "shellCommand": "psql -h localhost -U dev appdev", "queryFlag": "-c" }
```

For SQLite: `sqlite3 /path/db.sqlite "SELECT ..."` →
```json
"db": { "shellCommand": "sqlite3 /path/db.sqlite", "queryFlag": "" }
```

For MongoDB:
```json
"db": { "shellCommand": "mongosh appdev --quiet --eval", "queryFlag": "" }
```

### `auth`

How to authenticate the verify session. Four types:

```json
{ "type": "header", "header": "X-Dev-User", "value": "verify@test.local" }
{ "type": "loginUrl", "loginUrl": "http://localhost:3000/dev/login?email=v@x.io" }
{ "type": "form", "url": "/login", "email": "v@x.io", "password": "test1234" }
{ "type": "none" }
```

- **header**: most dev-friendly; the skill adds the header to all curl/browser requests.
- **loginUrl**: opens the URL once to set a session cookie before driving the real page.
- **form**: navigates to the login page, fills, submits.
- **none**: app has no auth in dev.

### `seed`

Command to seed the DB with known state before driving. Run once per verify session, after the server is up:

```json
"seed": "npm run seed:verify"
```

If the project has fixtures already loaded by `docker compose`, omit this.

### `evidenceDir`

Where to save screenshots, log excerpts, DB query results. Defaults to `.context/verify/` (which `/ship` knows to link from PR bodies).

## Examples

### Minimal — Next.js fullstack app

```json
{
  "dev": { "command": "npm run dev" },
  "logs": { "path": "/tmp/verify-server.log" },
  "db":   { "shellCommand": "sqlite3 ./dev.db", "queryFlag": "" }
}
```

### Monorepo with Docker

```json
{
  "dev": {
    "command": "docker compose up -d && pnpm --filter web dev",
    "readySignal": { "type": "http", "url": "http://localhost:3000", "expectStatus": 200 }
  },
  "teardown": "docker compose down",
  "logs": { "path": "/tmp/verify-server.log", "format": "json" },
  "db":   { "shellCommand": "psql -h localhost -U postgres app", "queryFlag": "-c" },
  "auth": { "type": "header", "header": "X-Dev-User", "value": "verify@test.local" }
}
```

### Django backend + React frontend (split)

```json
{
  "dev": {
    "frontend": { "command": "cd web && npm run dev", "port": 3000, "readyPath": "/" },
    "backend":  { "command": "python manage.py runserver 0.0.0.0:8000", "port": 8000, "readyPath": "/api/health" }
  },
  "logs": { "path": "/tmp/verify-django.log" },
  "db":   { "shellCommand": "psql -h localhost -U dev djangodev", "queryFlag": "-c" },
  "auth": { "type": "loginUrl", "loginUrl": "http://localhost:8000/dev-login/?email=v@x.io" }
}
```
