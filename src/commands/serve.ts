import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CommandHandler, Io } from '../cli.ts';
import { applyMigrations, defaultMigrationsDir, openDb } from '../db/migrate.ts';

// Ports probed on startup, in order. design.md § Server lifecycle: "No daemon;
// user runs `reviewdev serve` per repo." One repo per port keeps routing trivial.
export const PORT_RANGE = { start: 7891, end: 7899 } as const;

type FetchHandler = (req: Request) => Response | Promise<Response>;

// The slice of Bun's server object this module depends on. Narrowing it to an
// interface lets the port-probe logic be driven by a fake `ServeFn` in tests
// instead of binding real sockets.
export type RunningServer = { port: number; stop: () => void };
export type ServeFn = (port: number, fetch: FetchHandler) => RunningServer;

/**
 * Resolve the enclosing git repository root for `cwd`. `reviewdev serve` is
 * cwd-rooted: the SQLite DB and port file live under `<repo-root>/.reviewdev/`
 * (design.md § Architecture). Throws if `cwd` isn't inside a git work tree.
 */
export function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      // Capture git's stderr (don't inherit) so its "fatal: …" line feeds the
      // diagnostic below instead of leaking to the console.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error('reviewdev serve: git not found on PATH', { cause: err });
    }
    // git ran but exited non-zero — not a repo, or e.g. "dubious ownership"
    // (common in worktrees/containers). Surface git's own reason.
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim();
    throw new Error(
      `reviewdev serve: ${cwd} is not inside a git repository${stderr ? ` (${stderr})` : ''}`,
      { cause: err },
    );
  }
}

/**
 * Current schema version = the highest applied migration recorded in `meta`,
 * or 0 before any migration has run. Surfaced by `/health` so `publish` can
 * detect a server running an older schema.
 */
export function schemaVersion(db: Database): number {
  const row = db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM meta').get();
  return row?.v ?? 0;
}

/**
 * Build the Hono app. `getPort` is read at request time, not bound here,
 * because the listening port isn't known until the probe picks one — the app
 * is constructed before `listenInRange` runs.
 */
export function createApp(deps: { getPort: () => number; schemaVersion: number }): Hono {
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({ ok: true, port: deps.getPort(), schema_version: deps.schemaVersion }),
  );
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
  range: { start: number; end: number } = PORT_RANGE,
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
export function portRangeFromEnv(value: string | undefined): { start: number; end: number } {
  if (value === undefined || value.trim() === '') return PORT_RANGE;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `reviewdev serve: REVIEWDEV_PORT must be a port number between 1 and 65535, got '${value}'`,
    );
  }
  return { start: port, end: port };
}

// Real listener. Binds to localhost only — single-user, no auth surface
// (design.md § Security Considerations).
const bunServe: ServeFn = (port, fetch) => {
  const server = Bun.serve({ port, hostname: 'localhost', fetch });
  // `server.port` is typed `number | undefined` (undefined only for unix-socket
  // servers); we always bind a TCP port, so it equals the requested `port`.
  return { port: server.port ?? port, stop: () => server.stop(true) };
};

// One JSON object per line to stdout — structured logs, greppable, no deps.
function logLine(io: Io, event: string, fields: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

export const runServe: CommandHandler = async (_args, io) => {
  // Every startup failure path exits the same way: message (plus any underlying
  // cause) to stderr, exit 1. Handles non-Error throws without printing
  // "undefined" and surfaces the `cause` chain that listenInRange attaches.
  const fail = (err: unknown): number => {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause !== undefined
        ? `: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : '';
    io.stderr.write(`${msg}${cause}\n`);
    return 1;
  };

  let range: { start: number; end: number };
  try {
    range = portRangeFromEnv(process.env.REVIEWDEV_PORT);
  } catch (err) {
    return fail(err);
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch (err) {
    return fail(err);
  }

  const reviewDevDir = join(repoRoot, '.reviewdev');

  let db: Database;
  try {
    mkdirSync(reviewDevDir, { recursive: true });
    db = openDb(join(reviewDevDir, 'db.sqlite'));
  } catch (err) {
    return fail(err);
  }

  // Forward-only migrations on serve start (design.md § Data Model). A failure
  // here rolls back per-migration (T1.2) but still aborts startup — close the
  // handle and exit non-zero rather than serving against a half-migrated DB.
  let version: number;
  try {
    const ran = applyMigrations(db, defaultMigrationsDir());
    version = schemaVersion(db);
    logLine(io, 'migrations.applied', { count: ran.length, schema_version: version });
  } catch (err) {
    db.close();
    return fail(err);
  }

  let boundPort = 0;
  const app = createApp({ getPort: () => boundPort, schemaVersion: version });

  let server: RunningServer;
  try {
    server = listenInRange((req) => app.fetch(req), bunServe, range);
  } catch (err) {
    db.close();
    return fail(err);
  }
  boundPort = server.port;

  // Writing the port file is a named T1.3 deliverable (publish reads it), so a
  // failure here aborts startup through the same contract — release the socket
  // and DB handle rather than leaking them via an unhandled rejection.
  try {
    writeFileSync(join(reviewDevDir, 'port'), String(boundPort));
    logLine(io, 'serve.listening', {
      port: boundPort,
      repo_root: repoRoot,
      schema_version: version,
    });
  } catch (err) {
    server.stop();
    db.close();
    return fail(err);
  }

  // Foreground process: stay up until interrupted, then stop cleanly so the
  // socket and DB handle are released. The port file records the bound port;
  // `publish` reads it, confirms the server via GET /health, and errors out if
  // it's unreachable (SPEC.md § "no server for <repo>").
  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      logLine(io, 'serve.shutdown', { port: boundPort });
      server.stop();
      db.close();
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
