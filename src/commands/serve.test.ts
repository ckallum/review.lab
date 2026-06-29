import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { hunkId } from '../diff.ts';
import { applyMigrations, defaultMigrationsDir, openDb } from '../db/migrate.ts';
import { MAX_HUNKS } from '../db/revisions.ts';
import { dbPath, ensureReviewDevDir } from '../repo.ts';
import { PORT_RANGE, createApp, listenInRange, portRangeFromEnv, type ServeFn } from './serve.ts';

const noopFetch = () => new Response('ok');

/** A migrated in-memory DB for the createApp route tests. */
function freshDb(): Database {
  const db = openDb(':memory:');
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

// A fake ServeFn that reports the given ports as already taken, so the
// port-probe logic can be exercised without binding real sockets.
function fakeServe(busy: Set<number>): ServeFn {
  return (port) => {
    if (busy.has(port)) {
      const err = new Error(`port ${port} address already in use`) as Error & { code?: string };
      err.code = 'EADDRINUSE';
      throw err;
    }
    return { port, stop: () => {} };
  };
}

describe('createApp — GET /health', () => {
  it('returns ok, the live port, and schema_version', async () => {
    const app = createApp({ getPort: () => 7893, schemaVersion: 1, db: freshDb() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port: 7893, schema_version: 1 });
  });

  it('reads the port at request time (probe sets it after app construction)', async () => {
    let bound = 0;
    const app = createApp({ getPort: () => bound, schemaVersion: 2, db: freshDb() });
    bound = 7895;
    expect(await (await app.request('/health')).json()).toEqual({
      ok: true,
      port: 7895,
      schema_version: 2,
    });
  });

  it('404s an unknown path', async () => {
    const app = createApp({ getPort: () => 7891, schemaVersion: 1, db: freshDb() });
    expect((await app.request('/nope')).status).toBe(404);
  });
});

describe('createApp — POST /api/pr', () => {
  // Real content-addressed id so the body passes parseRevisionInput's id check.
  // Distinct (file, content) → distinct id, which controls dedup across tests.
  const hunk = (file: string, content: string) => ({
    id: hunkId(file, content),
    filePath: file,
    startLine: 1,
    endLine: 2,
    content,
    kind: 'mod' as const,
  });

  function post(app: ReturnType<typeof createApp>, body: unknown) {
    return app.request('/api/pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('creates a pull + revision and returns the revision URL', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    const res = await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'head1',
      baseSha: 'base1',
      hunks: [hunk('a.ts', '+a'), hunk('b.ts', '+b')],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pull_id: 1,
      revision_number: 1,
      url: 'http://127.0.0.1:7894/pr/1/rev/1',
    });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hunks').get()!.n).toBe(2);
  });

  it('dedupes an identical re-publish: same revision, no new row', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    const body = {
      branch: 'feature',
      base: 'main',
      headSha: 'h',
      baseSha: 'b',
      hunks: [hunk('a.ts', '+a')],
    };

    expect(await (await post(app, body)).json()).toMatchObject({ revision_number: 1 });
    // Re-post the same diff (even with a different head sha) → diff_hash matches,
    // so no new revision is minted and the existing URL comes back.
    const again = await post(app, { ...body, headSha: 'h2' });
    expect(await again.json()).toMatchObject({ pull_id: 1, revision_number: 1 });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(1);
  });

  it('appends revision 2 when the diff changes, bumping the pull', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'h1',
      baseSha: 'b',
      hunks: [hunk('a.ts', '+a')],
    });
    const first = db
      .query<{ updated_at: string }, []>('SELECT updated_at FROM pulls WHERE id = 1')
      .get()!.updated_at;

    const res = await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'h2',
      baseSha: 'b',
      hunks: [hunk('a.ts', '+a'), hunk('b.ts', '+b')],
    });
    expect(await res.json()).toMatchObject({ pull_id: 1, revision_number: 2 });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(2);
    // Hunks are filed under the pull derived from the revision, not the payload.
    const orphan = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hunks WHERE pull_id != 1')
      .get()!.n;
    expect(orphan).toBe(0);
    // updated_at advanced on the second publish (design.md § Writer invariants).
    const second = db
      .query<{ updated_at: string }, []>('SELECT updated_at FROM pulls WHERE id = 1')
      .get()!.updated_at;
    expect(second >= first).toBe(true);
  });

  it('400s an invalid body without writing anything', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    const res = await post(app, { base: 'main', headSha: 'h', baseSha: 'b', hunks: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/branch/);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(0);
  });

  it('400s more than MAX_HUNKS hunks without writing a revision', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    // Empty objects: the count cap fires before per-hunk validation.
    const res = await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'h',
      baseSha: 'b',
      hunks: new Array(MAX_HUNKS + 1).fill({}),
    });
    expect(res.status).toBe(400);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(0);
  });

  it('400s a hunk whose id does not match its content, writing nothing', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    const res = await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'h',
      baseSha: 'b',
      hunks: [{ ...hunk('a.ts', '+a'), id: 'tampered-id' }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not match/);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hunks').get()!.n).toBe(0);
  });

  it('400s a non-JSON body', async () => {
    const db = freshDb();
    const app = createApp({ getPort: () => 7894, schemaVersion: 1, db });
    const res = await app.request('/api/pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('answers a logged JSON 500 with request context when the write throws', async () => {
    const db = freshDb();
    const calls: Array<{ err: unknown; context?: Record<string, unknown> }> = [];
    const app = createApp({
      getPort: () => 7894,
      schemaVersion: 1,
      db,
      onError: (err, context) => calls.push({ err, context }),
    });
    db.close(); // a closed handle makes createRevision throw on its first query
    const res = await post(app, {
      branch: 'feature',
      base: 'main',
      headSha: 'h',
      baseSha: 'b',
      hunks: [hunk('a.ts', '+a')],
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/internal error/);
    // The throw is logged once, with the request identity in scope at the route.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toMatchObject({ branch: 'feature', hunk_count: 1 });
  });
});

describe('listenInRange', () => {
  it('binds the first port when the whole range is free', () => {
    const server = listenInRange(noopFetch, fakeServe(new Set()));
    expect(server.port).toBe(PORT_RANGE.start);
  });

  it('skips busy ports and binds the first free one', () => {
    const busy = new Set([7891, 7892]);
    expect(listenInRange(noopFetch, fakeServe(busy)).port).toBe(7893);
  });

  it('throws a range diagnostic naming the REVIEWDEV_PORT remedy when every port is occupied', () => {
    const range = { start: 7891, end: 7893 };
    const busy = new Set([7891, 7892, 7893]);
    expect(() => listenInRange(noopFetch, fakeServe(busy), range)).toThrow(
      /no free port in 7891-7893, set REVIEWDEV_PORT/,
    );
  });

  it('propagates a non-address-in-use bind error instead of probing on', () => {
    const serve: ServeFn = (port) => {
      throw new Error(`permission denied binding ${port}`);
    };
    expect(() => listenInRange(noopFetch, serve)).toThrow(/permission denied/);
  });

  it('detects EADDRINUSE by code even when the message would not match', () => {
    // Bun's real busy error reads "Failed to start server. Is port N in use?"
    // — which the narrowed message regex does NOT match. The code check must
    // still classify it as busy so the probe advances.
    const serve: ServeFn = (port) => {
      if (port < 7893) {
        const err = new Error(`Failed to start server. Is port ${port} in use?`) as Error & {
          code?: string;
        };
        err.code = 'EADDRINUSE';
        throw err;
      }
      return { port, stop: () => {} };
    };
    expect(listenInRange(noopFetch, serve).port).toBe(7893);
  });

  it('does not treat a generic "failed to start server" (no code) as busy', () => {
    // Same wording, but no EADDRINUSE code → a real bind failure, not a busy
    // port. It must propagate, not get suppressed and probed past.
    const serve: ServeFn = (port) => {
      throw new Error(`Failed to start server binding ${port}`);
    };
    expect(() => listenInRange(noopFetch, serve)).toThrow(/Failed to start server/);
  });
});

describe('portRangeFromEnv', () => {
  it('returns the default range when REVIEWDEV_PORT is unset or blank', () => {
    expect(portRangeFromEnv(undefined)).toEqual(PORT_RANGE);
    expect(portRangeFromEnv('')).toEqual(PORT_RANGE);
    expect(portRangeFromEnv('  ')).toEqual(PORT_RANGE);
  });

  it('pins to a single port when REVIEWDEV_PORT is a valid port', () => {
    expect(portRangeFromEnv('5000')).toEqual({ start: 5000, end: 5000 });
  });

  it('throws on a non-port value rather than silently using the default range', () => {
    for (const bad of ['abc', '0', '70000', '80.5', '-1']) {
      expect(() => portRangeFromEnv(bad)).toThrow(/REVIEWDEV_PORT must be a port number/);
    }
  });
});

// resolveRepoRoot + the .reviewdev path/port helpers now live in ../repo.ts and
// are covered in src/repo.test.ts.

// End-to-end: spawn the real `reviewdev serve` in a throwaway git repo and
// prove it boots foreground, applies migrations, writes the port file, and
// answers /health over HTTP — then shuts down cleanly on SIGINT.
describe('reviewdev serve (subprocess)', () => {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
  let dir: string;
  let child: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-serve-e2e-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGINT');
      await new Promise((r) => child!.once('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots, serves /health, and shuts down cleanly on SIGINT', async () => {
    child = spawn('bun', [cliPath, 'serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b) => (stderr += b));

    const portFile = join(dir, '.reviewdev', 'port');
    await waitFor(
      () => existsSync(portFile),
      8000,
      () => `port file never appeared. stderr: ${stderr}`,
    );

    const port = Number(readFileSync(portFile, 'utf8').trim());
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE.start);
    expect(port).toBeLessThanOrEqual(PORT_RANGE.end);

    // 127.0.0.1, not localhost — serve pins the IPv4 family (see bunServe).
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port, schema_version: 1 });

    // Migrations ran against the per-repo DB.
    expect(existsSync(join(dir, '.reviewdev', 'db.sqlite'))).toBe(true);

    // SIGINT triggers the graceful shutdown path → exit 0 (not a crash).
    child.kill('SIGINT');
    const code = await new Promise<number | null>((r) => child!.once('exit', (c) => r(c)));
    expect(code).toBe(0);
  });

  it('skips a port already held by another process and advances past it', async () => {
    // Regression test: 'localhost' resolves to both 127.0.0.1 and ::1, so a
    // serve binding the hostname could grab a different family of an occupied
    // port and never advance. Hold the range-start on 127.0.0.1 (the family
    // serve pins) and assert serve probes past it instead of colliding.
    const squatter = Bun.serve({
      port: PORT_RANGE.start,
      hostname: '127.0.0.1',
      fetch: () => new Response('squatter'),
    });
    try {
      child = spawn('bun', [cliPath, 'serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', (b) => (stderr += b));

      const portFile = join(dir, '.reviewdev', 'port');
      await waitFor(
        () => existsSync(portFile),
        8000,
        () => `port file never appeared. stderr: ${stderr}`,
      );

      const port = Number(readFileSync(portFile, 'utf8').trim());
      expect(port).toBeGreaterThan(PORT_RANGE.start); // advanced past the squatter
      expect(port).toBeLessThanOrEqual(PORT_RANGE.end);

      // serve answers on its own port; the squatter still owns the range-start.
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({
        ok: true,
        port,
        schema_version: 1,
      });
      expect(await (await fetch(`http://127.0.0.1:${PORT_RANGE.start}/`)).text()).toBe('squatter');
    } finally {
      squatter.stop(true);
    }
  });

  it('exits 1 with a diagnostic when cwd is not a git repository', async () => {
    const nonRepo = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-serve-nogit-')));
    try {
      const proc = spawn('bun', [cliPath, 'serve'], {
        cwd: nonRepo,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr!.on('data', (b) => (stderr += b));
      const code = await new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
      expect(code).toBe(1);
      expect(stderr).toMatch(/not inside a git repository/);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('refuses to start when the DB schema is newer than the bundled migrations', async () => {
    // Seed a DB whose meta claims a version ahead of what this binary bundles —
    // as if migrated by a newer reviewdev. serve must refuse, not advertise a
    // schema it can't serve.
    ensureReviewDevDir(dir);
    const seed = openDb(dbPath(dir));
    applyMigrations(seed, defaultMigrationsDir());
    seed.run('INSERT INTO meta (version, filename) VALUES (?, ?)', [999, '999_future.sql']);
    seed.close();

    const proc = spawn('bun', [cliPath, 'serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr!.on('data', (b) => (stderr += b));
    const code = await new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
    expect(code).toBe(1);
    expect(stderr).toMatch(/newer than this reviewdev/);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Evaluate the message at throw time so it captures stderr accumulated during
  // the wait, not the empty string it held at call time.
  throw new Error(`waitFor timed out: ${message()}`);
}
