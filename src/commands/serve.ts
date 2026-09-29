import { basename } from 'node:path';
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { fail, type CommandHandler } from '../cli.ts';
import {
  applyMigrations,
  currentVersion,
  defaultMigrationsDir,
  latestMigrationVersion,
  openDb,
} from '../db/migrate.ts';
import {
  dbPath,
  ensureReviewDevDir,
  resolveRepoRoot,
  serverOrigin,
  writePortFile,
} from '../repo.ts';
import { logLine } from '../log.ts';
import { createRevision, parseRevisionInput } from '../db/revisions.ts';
import {
  findRevision,
  latestRevisionNumber,
  readRevisionSnapshot,
  type MissingRevision,
} from '../db/snapshot.ts';
import { buildRevisionView } from '../revision-view.ts';
import { loadIndexHtml } from '../web.ts';

// Ports probed on startup, in order. design.md § Server lifecycle: "No daemon;
// user runs `reviewdev serve` per repo." One repo per port keeps routing trivial.
export const PORT_RANGE = { start: 7891, end: 7899 } as const;

// An inclusive span of ports to probe. `PORT_RANGE` (a const literal) satisfies
// it, and `portRangeFromEnv` narrows it to a single port for `REVIEWDEV_PORT`.
export type PortRange = { start: number; end: number };

type FetchHandler = (req: Request) => Response | Promise<Response>;

// The slice of Bun's server object this module depends on. Narrowing it to an
// interface lets the port-probe logic be driven by a fake `ServeFn` in tests
// instead of binding real sockets.
export type RunningServer = { port: number; stop: () => void };
export type ServeFn = (port: number, fetch: FetchHandler) => RunningServer;

// Hosts the server answers for; guards against DNS rebinding.
// - Binding 127.0.0.1 isn't enough: another origin can resolve its own hostname to
//   127.0.0.1 and read the source-returning GET routes.
// - A rebound request still carries the foreign Host, so it's rejected here.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

/** null when Bun couldn't build an absolute URL (HTTP/1.0 with no Host, or a malformed Host). */
function requestHostname(url: string): string | null {
  return URL.canParse(url) ? new URL(url).hostname : null;
}

// Every response, errors included, is uncacheable: the /pr/:id redirect target
// moves on each publish, and revision JSON carries repo source.
function withResponseHeaders(res: Response): Response {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
}

/**
 * Parse a route id segment: a canonical positive integer (no sign, no leading zero,
 * no exponent), safe as a JS number. Returns null for anything else, so every route
 * rejects malformed ids with the same 400 rather than a lookup miss.
 */
export function parsePositiveIntParam(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** 404 body for a revision that doesn't exist. `latest_revision_number` is always present. */
function missingRevisionBody(
  lookup: MissingRevision,
  pullId: number,
  n: number,
): { error: string; latest_revision_number: number | null } {
  if (lookup.kind === 'no-pull') {
    return { error: `pull ${pullId} not found`, latest_revision_number: null };
  }
  if (lookup.latest === null) {
    return { error: `pull ${pullId} has no revisions`, latest_revision_number: null };
  }
  return {
    error: `revision ${n} not found for pull ${pullId}`,
    latest_revision_number: lookup.latest,
  };
}

/**
 * Build the Hono app. `getPort` is read at request time, not bound here,
 * because the listening port isn't known until the probe picks one — the app
 * is constructed before `listenInRange` runs. `db` is the single per-repo
 * handle every route reads and writes through.
 */
export function createApp(deps: {
  getPort: () => number;
  schemaVersion: number;
  db: Database;
  // The repo this server is rooted at. Echoed by /health so `publish` can
  // confirm a (possibly stale) `.reviewdev/port` points at THIS repo's server,
  // not another repo's that happens to hold the same port — which would
  // otherwise route this repo's write into the wrong DB.
  repoRoot: string;
  // The revision page (web/index.html), read once at serve start. Required: an empty
  // default would answer every revision URL with a blank page.
  indexHtml: string;
  // Diagnostic sink for an unexpected route throw (default no-op). `runServe`
  // wires it to the structured log so a failed write leaves a server-side trace
  // (message + stack + request identity) instead of vanishing into a bare 500.
  onError?: (err: unknown, context?: Record<string, unknown>) => void;
}): Hono {
  const app = new Hono();
  const repoSlug = basename(deps.repoRoot);

  app.use('*', async (c, next) => {
    const host = requestHostname(c.req.url);
    if (host === null || !ALLOWED_HOSTS.has(host)) {
      return withResponseHeaders(c.json({ error: 'host not allowed' }, 403));
    }
    await next();
    withResponseHeaders(c.res);
  });

  app.get('/health', (c) =>
    c.json({
      ok: true,
      port: deps.getPort(),
      schema_version: deps.schemaVersion,
      repo_root: deps.repoRoot,
    }),
  );

  // Upsert pull + create revision (T1.5). The CLI POSTs the resolved diff here;
  // the server owns the write so revision numbering and duplicate detection
  // happen against one DB handle.
  app.post('/api/pr', async (c) => {
    // A cross-site page can send a text/plain or form POST without a CORS preflight,
    // and its Host is 127.0.0.1. Requiring JSON forces the preflight, which fails
    // because no CORS headers are ever sent.
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return c.json({ error: 'content-type must be application/json' }, 415);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400);
    }
    let input;
    try {
      input = parseRevisionInput(raw);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    // A throw here (SQLITE_BUSY, an unexpected constraint violation) is caught
    // and logged WITH the request identity that's in scope — app.onError below
    // can't see the parsed input, so a generic 500 there would be contextless.
    let result;
    try {
      result = createRevision(deps.db, input);
    } catch (err) {
      deps.onError?.(err, {
        route: 'POST /api/pr',
        branch: input.branch,
        base_sha: input.baseSha,
        head_sha: input.headSha,
        hunk_count: input.hunks.length,
      });
      return c.json({ error: 'internal error creating revision' }, 500);
    }
    // The URL points at the resulting revision — identical for a fresh revision
    // or a deduped re-publish, so `result.created` need not reach the client
    // (the dedupe outcome is observable to the CLI via the unchanged URL).
    const url = `${serverOrigin(deps.getPort())}/pr/${result.pullId}/rev/${result.revisionNumber}`;
    return c.json({ pull_id: result.pullId, revision_number: result.revisionNumber, url });
  });

  // JSON for one pinned revision (T1.9) — what web/index.html renders. A zero-hunk
  // revision is a 200 (pure-rename and binary-only diffs parse to no hunks); the
  // page shows it as an explicit empty state.
  app.get('/api/pr/:id/rev/:n', (c) => {
    const pullId = parsePositiveIntParam(c.req.param('id'));
    if (pullId === null) return c.json({ error: 'pull id must be a positive integer' }, 400);
    const n = parsePositiveIntParam(c.req.param('n'));
    if (n === null) return c.json({ error: 'revision number must be a positive integer' }, 400);
    try {
      const read = readRevisionSnapshot(deps.db, pullId, n);
      if (!read.ok) return c.json(missingRevisionBody(read.lookup, pullId, n), 404);
      return c.json(buildRevisionView(read.snapshot, repoSlug));
    } catch (err) {
      deps.onError?.(err, { route: 'GET /api/pr/:id/rev/:n', pull_id: pullId, revision_number: n });
      return c.json({ error: 'internal error reading revision' }, 500);
    }
  });

  // The latest revision is the default landing (SPEC.md § Revisions). 302, not 301/308:
  // the target moves on every publish and must never be cached.
  app.get('/pr/:id', (c) => {
    const pullId = parsePositiveIntParam(c.req.param('id'));
    if (pullId === null) return c.text('pull id must be a positive integer', 400);
    let latest: number | null;
    try {
      latest = latestRevisionNumber(deps.db, pullId);
    } catch (err) {
      deps.onError?.(err, { route: 'GET /pr/:id', pull_id: pullId });
      return c.text('internal error', 500);
    }
    if (latest === null) return c.text(`pull ${pullId} not found`, 404);
    return c.redirect(`/pr/${pullId}/rev/${latest}`, 302);
  });

  // The page itself, served verbatim. Its status mirrors the revision lookup for the
  // same ids (200/400/404/500), so curl and scripts see whether the revision exists.
  // Building the view is left to the JSON route the page fetches, whose own 500
  // gets the page's error screen.
  app.get('/pr/:id/rev/:n', (c) => {
    const pullId = parsePositiveIntParam(c.req.param('id'));
    const n = parsePositiveIntParam(c.req.param('n'));
    if (pullId === null || n === null) return c.html(deps.indexHtml, 400);
    try {
      return c.html(deps.indexHtml, findRevision(deps.db, pullId, n).kind === 'found' ? 200 : 404);
    } catch (err) {
      deps.onError?.(err, { route: 'GET /pr/:id/rev/:n', pull_id: pullId, revision_number: n });
      return c.html(deps.indexHtml, 500);
    }
  });

  // Last-resort handler for any OTHER unhandled route throw: log it (so the
  // reason survives) and return a JSON body the CLI can surface, rather than
  // Hono's default bare "500 Internal Server Error" with nothing logged.
  app.onError((err, c) => {
    deps.onError?.(err, { method: c.req.method, path: c.req.path });
    return withResponseHeaders(c.json({ error: 'internal error handling request' }, 500));
  });

  return app;
}

// A bind failure caused by the port already being taken — the one error
// `listenInRange` swallows to try the next port. Anything else (permission,
// bad hostname) propagates immediately rather than being misread as "busy".
function isAddrInUse(err: unknown): boolean {
  // `code` is the reliable signal — Bun and Node both set EADDRINUSE on a
  // port-in-use bind. The message check is only a narrow fallback for errors
  // that carry no code; kept tight (no generic "failed to start server") so an
  // unrelated bind failure isn't misread as busy and silently probed past.
  if ((err as { code?: string } | null)?.code === 'EADDRINUSE') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /eaddrinuse|address already in use/i.test(msg);
}

/**
 * Bind the first free port in `range` using the injected `serve`. Skips ports
 * that are already in use and throws only when the whole range is occupied.
 */
export function listenInRange(
  fetch: FetchHandler,
  serve: ServeFn,
  range: PortRange = PORT_RANGE,
): RunningServer {
  let lastErr: unknown;
  for (let port = range.start; port <= range.end; port++) {
    try {
      return serve(port, fetch);
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `reviewdev serve: no free port in ${range.start}-${range.end}, set REVIEWDEV_PORT`,
    { cause: lastErr },
  );
}

/**
 * Resolve the port range to probe. `REVIEWDEV_PORT`, when set, pins serve to a
 * single explicit port (the escape hatch named in the all-ports-busy error and
 * SPEC.md § failure modes); otherwise the default 7891–7899 range is probed.
 * Throws on a non-port value so a typo fails fast rather than silently falling
 * back to the default range.
 */
export function portRangeFromEnv(value: string | undefined): PortRange {
  if (value === undefined || value.trim() === '') return PORT_RANGE;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `reviewdev serve: REVIEWDEV_PORT must be a port number between 1 and 65535, got '${value}'`,
    );
  }
  return { start: port, end: port };
}

// Real listener. Binds 127.0.0.1 — single-user, no auth surface
// (design.md § Security Considerations).
//
// 127.0.0.1, NOT the hostname 'localhost': 'localhost' resolves to both
// 127.0.0.1 and ::1, so two serve processes can each bind a different family of
// the same port without a conflict — which silently defeats the port probe (a
// client hitting localhost:PORT then lands on either server nondeterministically).
// Pinning one family makes a taken port throw EADDRINUSE so the probe advances.
const bunServe: ServeFn = (port, fetch) => {
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch });
  // `server.port` is typed `number | undefined` (undefined only for unix-socket
  // servers); we always bind a TCP port, so it equals the requested `port`.
  return { port: server.port ?? port, stop: () => server.stop(true) };
};

export const runServe: CommandHandler = async (_args, io) => {
  // Every startup failure path exits the same way via the shared `fail` (stderr
  // message + cause chain, exit 1) — including the `cause` that listenInRange
  // attaches and git's "fatal: …" stderr from resolveRepoRoot.
  let range: PortRange;
  try {
    range = portRangeFromEnv(process.env.REVIEWDEV_PORT);
  } catch (err) {
    return fail(io, err);
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch (err) {
    return fail(io, err);
  }

  // Before .reviewdev/ is created or the DB opened, so a broken install fails
  // without side effects.
  let indexHtml: string;
  try {
    indexHtml = loadIndexHtml();
  } catch (err) {
    return fail(io, err);
  }

  let db: Database;
  try {
    ensureReviewDevDir(repoRoot);
    db = openDb(dbPath(repoRoot));
  } catch (err) {
    return fail(io, err);
  }

  // Forward-only migrations on serve start (design.md § Data Model). A failure
  // here rolls back per-migration (T1.2) but still aborts startup — close the
  // handle and exit non-zero rather than serving against a half-migrated DB.
  let version: number;
  try {
    const ran = applyMigrations(db, defaultMigrationsDir());
    version = currentVersion(db);
    logLine(io.stdout, 'migrations.applied', { count: ran.length, schema_version: version });
  } catch (err) {
    db.close();
    return fail(io, err);
  }

  // Refuse a DB migrated by a NEWER reviewdev than this binary bundles —
  // applyMigrations is forward-only, so it can't downgrade, and /health would
  // otherwise advertise a schema this code can't actually serve.
  const bundled = latestMigrationVersion(defaultMigrationsDir());
  if (version > bundled) {
    db.close();
    return fail(
      io,
      new Error(
        `reviewdev serve: database schema v${version} is newer than this reviewdev (bundles v${bundled}); upgrade reviewdev`,
      ),
    );
  }

  let boundPort = 0;
  const app = createApp({
    getPort: () => boundPort,
    schemaVersion: version,
    db,
    repoRoot,
    indexHtml,
    onError: (err, context) =>
      logLine(io.stdout, 'api.error', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ...context,
      }),
  });

  let server: RunningServer;
  try {
    server = listenInRange((req) => app.fetch(req), bunServe, range);
  } catch (err) {
    db.close();
    return fail(io, err);
  }
  boundPort = server.port;

  // Writing the port file is a named T1.3 deliverable (publish reads it), so a
  // failure here aborts startup through the same contract — release the socket
  // and DB handle rather than leaking them via an unhandled rejection.
  try {
    writePortFile(repoRoot, boundPort);
    logLine(io.stdout, 'serve.listening', {
      port: boundPort,
      repo_root: repoRoot,
      schema_version: version,
    });
  } catch (err) {
    server.stop();
    db.close();
    return fail(io, err);
  }

  // Foreground process: stay up until interrupted, then stop cleanly so the
  // socket and DB handle are released. The port file records the bound port;
  // `publish` reads it, confirms the server via GET /health, and errors out if
  // it's unreachable (SPEC.md § "no server for <repo>").
  return await new Promise<number>((resolve) => {
    // Idempotent: if both SIGINT and SIGTERM arrive during teardown, only the
    // first runs server.stop() / db.close() — the rest are no-ops.
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logLine(io.stdout, 'serve.shutdown', { port: boundPort });
      server.stop();
      db.close();
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
