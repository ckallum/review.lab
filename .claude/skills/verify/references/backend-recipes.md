---
_origin: calsuite@dfaf5b4
---

# Backend verification recipes

Patterns for driving HTTP / RPC / queue endpoints, reading structured logs, and querying the DB to prove a backend change actually ran.

## The core loop

```bash
# 1. Make the request
curl -fsS -X POST http://localhost:8080/api/widgets \
  -H 'Content-Type: application/json' \
  -H 'X-Dev-User: verify@test.local' \
  -d '{"name": "verify-test", "color": "red"}' \
  -o /tmp/verify-response.json \
  -w "HTTP %{http_code}\n"

# 2. Assert on the response
jq -e '.id and .name == "verify-test"' /tmp/verify-response.json

# 3. Grep the log for the expected path marker
grep -E "widget.created.*verify-test" "$VERIFY_LOG"

# 4. Query the DB to confirm the row landed
psql -h localhost -U dev appdev -c \
  "SELECT id, name, color, created_at FROM widgets WHERE name = 'verify-test';"
```

All three layers of proof — response, log line, DB row. A 200 means the handler returned; the log means it executed the path; the row means it actually wrote.

## Curl patterns

### POST with JSON body

```bash
curl -fsS -X POST http://localhost:8080/api/<resource> \
  -H 'Content-Type: application/json' \
  -d @/tmp/verify-payload.json
```

`-fsS` is load-bearing: `-f` makes curl exit non-zero on 4xx/5xx, `-s` quiets progress, `-S` still shows errors. Without `-f`, a 500 looks like success to the shell.

### File upload

```bash
curl -fsS -X POST http://localhost:8080/api/upload \
  -F "file=@/tmp/verify-fixture.png" \
  -F "metadata={\"alt\":\"test\"};type=application/json"
```

### Auth header

```bash
curl -fsS -H "Authorization: Bearer $(cat /tmp/verify-token)" ...
# Or dev bypass:
curl -fsS -H "X-Dev-User: verify@test.local" ...
```

### Streaming / SSE

```bash
# Verify the stream emits the expected event(s)
curl -fsS -N http://localhost:8080/api/stream \
  | head -20 \
  | grep -F "event: widget.created"
```

`-N` disables curl buffering so events arrive promptly.

### gRPC / RPC

If the backend isn't HTTP:

```bash
# grpcurl
grpcurl -plaintext -d '{"name": "verify"}' localhost:50051 widget.WidgetService/Create
```

## Log assertions

The verification matrix's most powerful pattern: structured logs that Claude can grep.

### What to grep for

Pick a marker the change emits at the path you're verifying. Markers should be:
- Stable across requests (not timestamps or IDs)
- Specific to the path (not generic like `request.received`)
- Easy to grep (no special regex chars)

Good: `widget.created`, `signup.completed`, `migration.applied.0042_users`
Bad: `received POST /api/widgets` (matches every request), `created` (matches everything)

### Structured logs

If logs are JSON:

```bash
jq -c 'select(.event == "widget.created" and .name == "verify-test")' "$VERIFY_LOG"
```

If they're plain text with a known format:

```bash
grep -E '"event":"widget.created".*"name":"verify-test"' "$VERIFY_LOG"
```

### Adding log lines

If the path you're verifying is silent — no log line emits when the handler runs — **add one as part of this PR**. The line costs ~1ms, makes the path observable forever, and lets verify prove itself on every future change.

```python
# Python
logger.info("widget.created", extra={"id": widget.id, "name": widget.name})
```
```typescript
// TypeScript
logger.info({ event: "widget.created", id: widget.id, name: widget.name });
```
```go
// Go
logger.Info("widget.created", "id", widget.ID, "name", widget.Name)
```

Pick the right spot — after the write commits, before returning the response. A log line that fires before the write is a lie.

## DB query patterns

The receipt for any write path. Don't trust HTTP 200 alone for writes.

### Postgres

```bash
psql -h localhost -U dev appdev -c \
  "SELECT * FROM widgets WHERE name = 'verify-test' ORDER BY id DESC LIMIT 1;"
```

For JSON columns:
```bash
psql -h localhost -U dev appdev -c \
  "SELECT id, metadata->>'color' FROM widgets WHERE metadata->>'name' = 'verify-test';"
```

### MySQL

```bash
mysql -h localhost -u dev -ppassword appdev -e \
  "SELECT * FROM widgets WHERE name = 'verify-test' ORDER BY id DESC LIMIT 1;"
```

### SQLite

```bash
sqlite3 /path/to/db.sqlite \
  "SELECT * FROM widgets WHERE name = 'verify-test' ORDER BY id DESC LIMIT 1;"
```

### MongoDB

```bash
mongosh appdev --quiet --eval \
  'db.widgets.find({ name: "verify-test" }).sort({ _id: -1 }).limit(1).pretty()'
```

### ORM-specific

For Prisma:
```bash
npx prisma studio &   # GUI; use only if scripting fails
# Or programmatic:
node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.widget.findFirst({ where: { name: 'verify-test' }}).then(console.log).then(()=>process.exit());
"
```

## Cleaning up test data

Each verify run leaves rows behind. Two strategies:

1. **Unique markers per run** — name the row `verify-test-$(date +%s)` so successive runs don't collide. Don't delete; let it accumulate.
2. **Cleanup at the end** — `DELETE FROM widgets WHERE name LIKE 'verify-test%'` in the teardown step.

For dev DBs, accumulation is usually fine. For shared DBs (don't use these for verify), cleanup matters.

## Sidecar services

If the backend depends on Redis, Postgres, RabbitMQ, etc., they need to be running too. Use `docker compose up -d` to bring them all up at once, and check health before driving:

```bash
docker compose ps --format json | jq -e 'all(.Health == "healthy" or .State == "running")'
```

If a sidecar is missing health metadata, fall back to a connect-test:

```bash
redis-cli -h localhost ping  # expect PONG
pg_isready -h localhost -U dev
```

## Replaying production traffic

For changes affecting handlers that take complex inputs (webhooks, GraphQL queries, gRPC), the strongest verification is replaying a real captured request:

```bash
# Save a real request from prod logs (or a fixture)
cat /tmp/verify-captured.json | curl -fsS -X POST http://localhost:8080/webhook \
  -H 'Content-Type: application/json' \
  -d @-
```

This catches edge cases hand-crafted fixtures miss. If the repo has a `fixtures/` or `testdata/` directory of captured payloads, prefer those over invented ones.

## Common pitfalls

- **`curl` without `-f`** — 5xx looks like success. Always `-fsS`.
- **No `-w "%{http_code}"`** — you don't see the status code unless it errored. Add it for the log.
- **Forgetting Content-Type** — many APIs return 415 silently. Always set it for JSON/multipart.
- **Log line timing** — if you log before the DB commit, the line proves nothing. Log after the write returns.
- **DB caching** — some ORMs cache reads. If your query returns stale data, force a fresh connection.
- **Async writes** — if the handler queues a job, the DB row appears later. Either poll for the row (with a timeout) or verify the queue entry instead.
