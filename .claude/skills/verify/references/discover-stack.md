---
_origin: calsuite@dfaf5b4
---

# Discovering the stack

How to figure out what the project is and how to run it, without assuming.

## Order of authority

1. `.claude/verify-config.json` — explicit declaration, trust it absolutely.
2. `CLAUDE.md` — usually has a "how to run" section.
3. The README — sometimes more accurate than CLAUDE.md.
4. Auto-discovery from the files below.

## Auto-discovery signals

### `package.json`

```bash
test -f package.json && jq -r '.scripts | keys[]' package.json
```

The canonical script names, in priority order:
- `dev` — almost always the right one
- `start:dev`, `start-dev`
- `serve`
- `start` — only if no `dev`; sometimes runs prod build

Detect what `dev` actually starts:
- `next dev` → Next.js (port 3000 default)
- `vite` → Vite SPA (port 5173 default)
- `nuxt dev` → Nuxt (port 3000)
- `nodemon`, `tsx watch`, `ts-node-dev` → Node server, port varies
- `concurrently` / `npm-run-all` → multiple processes, may need to dig

Detect the stack from `dependencies` / `devDependencies`:
- `react`, `react-dom` → React
- `vue` → Vue
- `svelte`, `@sveltejs/kit` → Svelte/SvelteKit
- `next` → Next.js (fullstack-capable)
- `express`, `fastify`, `hono`, `@nestjs/core` → Node backend
- `prisma`, `drizzle-orm`, `typeorm`, `mongoose` → DB layer

### `Makefile`

```bash
test -f Makefile && grep -E '^[a-zA-Z_-]+:' Makefile | head -20
```

Common targets:
- `make dev`, `make run`, `make serve`
- `make up` — usually `docker compose up`
- `make test`, `make e2e`
- `make migrate`, `make seed`

### `docker-compose.yml`

```bash
test -f docker-compose.yml && yq -r '.services | keys[]' docker-compose.yml 2>/dev/null
# Or without yq:
test -f docker-compose.yml && grep -E '^  [a-zA-Z_-]+:' docker-compose.yml
```

If present, `docker compose up -d` is almost always the right way to start the backend (with DB, Redis, etc.). Ports are declared in the file under `ports:`.

### Python projects

```bash
test -f pyproject.toml && cat pyproject.toml | grep -E '(django|fastapi|flask|uvicorn)'
test -f manage.py && echo "Django: python manage.py runserver"
test -f main.py && grep -l "FastAPI\|Flask" main.py
```

Common commands:
- Django: `python manage.py runserver` (port 8000)
- FastAPI: `uvicorn main:app --reload` (port 8000)
- Flask: `flask run` (port 5000)

### Go projects

```bash
test -f go.mod && grep -E '^(module|go)' go.mod
ls cmd/ 2>/dev/null  # standard layout: cmd/<service>/main.go
```

`go run ./cmd/<service>` or `air` (hot-reload tool) if installed.

### Rust projects

```bash
test -f Cargo.toml && grep -A1 '\[package\]' Cargo.toml
```

`cargo run` for a single-binary project; check `[[bin]]` entries for multi-binary.

### Monorepos

If you see `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`, or `package.json` with a `workspaces` field, the dev command is usually scoped:

- pnpm: `pnpm --filter <pkg> dev`
- turbo: `turbo run dev` (runs all in parallel)
- nx: `nx serve <app>`

Check the root README — monorepos almost always document the recommended dev command.

## Port discovery

After starting the server, find what port it's listening on (don't assume 3000):

```bash
# From the log (source state from Step 3 for $VERIFY_LOG / $VERIFY_PID)
source /tmp/verify-state.env
grep -oE 'http://localhost:[0-9]+' "$VERIFY_LOG" | head -1

# Or check the process
lsof -iTCP -sTCP:LISTEN -P -n | grep "$VERIFY_PID"
```

Save the port to a shell variable; subsequent steps use it.

## What to do when discovery fails

If none of the above turn up a runnable command:

1. Read the README and `CLAUDE.md` once more, looking for *anything* that hints at a dev command.
2. Look for shell scripts in `scripts/`, `bin/`, `dev/` — projects sometimes hide the command there.
3. As a last resort, ask the user: "I can't find how to start the dev server. What's the command?"

Don't fabricate a guess. A wrong `npm run dev` that fails three times wastes more time than asking.
