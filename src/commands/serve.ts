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
import { dbPath, ensureReviewDevDir, resolveRepoRoot, writePortFile } from '../repo.ts';
import { logLine } from '../log.ts';

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
    logLine(io, 'migrations.applied', { count: ran.length, schema_version: version });
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
  const app = createApp({ getPort: () => boundPort, schemaVersion: version });

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
    logLine(io, 'serve.listening', {
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
      logLine(io, 'serve.shutdown', { port: boundPort });
      server.stop();
      db.close();
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
