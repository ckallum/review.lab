import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { hunkId, parseDiff, type ParsedHunk } from '../diff.ts';
import { applyMigrations, defaultMigrationsDir, openDb } from '../db/migrate.ts';
import { MAX_HUNKS } from '../db/revisions.ts';
import { dbPath, ensureReviewDevDir } from '../repo.ts';
import type { RevisionView } from '../revision-view.ts';
import { GOLDEN_BASE, GOLDEN_BRANCH, GOLDEN_DIFF, GOLDEN_VIEW } from '../revision-view.fixture.ts';
import {
  PORT_RANGE,
  createApp,
  listenInRange,
  parsePositiveIntParam,
  portRangeFromEnv,
  type ServeFn,
} from './serve.ts';

const noopFetch = () => new Response('ok');

/** A migrated in-memory DB for the createApp route tests. */
function freshDb(): Database {
  const db = openDb(':memory:');
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

// The page body the /pr routes serve in route tests; web.test.ts covers the real file.
const SHELL = '<!doctype html><title>test shell</title>';

/** createApp with test defaults; each test overrides the deps it asserts on. */
function makeApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    getPort: () => 7894,
    schemaVersion: 1,
    repoRoot: '/repo',
    indexHtml: SHELL,
    ...overrides,
    db: overrides.db ?? freshDb(),
  });
}

type App = ReturnType<typeof createApp>;

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

function post(app: App, body: unknown) {
  return app.request('/api/pr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ParsedHunk is the POST /api/pr hunk shape, so parsed hunks go on the wire as-is.
const GOLDEN_HUNKS: readonly ParsedHunk[] = parseDiff(GOLDEN_DIFF);

/** Publish `hunks` on `branch` (base GOLDEN_BASE) and return the ids the server assigned. */
async function seedRevision(
  app: App,
  hunks: readonly ParsedHunk[] = GOLDEN_HUNKS,
  branch: string = GOLDEN_BRANCH,
): Promise<{ pull_id: number; revision_number: number }> {
  const res = await post(app, { branch, base: GOLDEN_BASE, headSha: 'h', baseSha: 'b', hunks });
  expect(res.status).toBe(200);
  return (await res.json()) as { pull_id: number; revision_number: number };
}

/** A pull row with no revisions: the writer can't produce one, so it's inserted directly. */
function insertBarePull(db: Database): void {
  db.run(`INSERT INTO pulls (branch, base) VALUES ('bare', 'main')`);
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
    const app = makeApp({
      getPort: () => 7893,
      schemaVersion: 1,
      db: freshDb(),
      repoRoot: '/repo',
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      port: 7893,
      schema_version: 1,
      repo_root: '/repo',
    });
  });

  it('reads the port at request time (probe sets it after app construction)', async () => {
    let bound = 0;
    const app = makeApp({
      getPort: () => bound,
      schemaVersion: 2,
      db: freshDb(),
      repoRoot: '/repo',
    });
    bound = 7895;
    expect(await (await app.request('/health')).json()).toEqual({
      ok: true,
      port: 7895,
      schema_version: 2,
      repo_root: '/repo',
    });
  });

  it('404s an unknown path', async () => {
    const app = makeApp({
      getPort: () => 7891,
      schemaVersion: 1,
      db: freshDb(),
      repoRoot: '/repo',
    });
    expect((await app.request('/nope')).status).toBe(404);
  });
});

describe('createApp — POST /api/pr', () => {
  it('creates a pull + revision and returns the revision URL', async () => {
    const db = freshDb();
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
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
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
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
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
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
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
    const res = await post(app, { base: 'main', headSha: 'h', baseSha: 'b', hunks: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/branch/);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(0);
  });

  it('400s more than MAX_HUNKS hunks without writing a revision', async () => {
    const db = freshDb();
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
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
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
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
    const app = makeApp({ getPort: () => 7894, schemaVersion: 1, db, repoRoot: '/repo' });
    const res = await app.request('/api/pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('415s a body that is not declared application/json, writing nothing', async () => {
    const db = freshDb();
    const app = makeApp({ db });
    const body = JSON.stringify({
      branch: 'feature',
      base: 'main',
      headSha: 'h',
      baseSha: 'b',
      hunks: [hunk('a.ts', '+a')],
    });
    // text/plain and form posts are what a cross-site page can send without a preflight.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await app.request('/api/pr', {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body,
      });
      expect(res.status, String(type)).toBe(415);
      expect(await res.json()).toEqual({ error: 'content-type must be application/json' });
    }
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(0);

    const ok = await app.request('/api/pr', {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it('answers a logged JSON 500 with request context when the write throws', async () => {
    const db = freshDb();
    const calls: Array<{ err: unknown; context?: Record<string, unknown> }> = [];
    const app = makeApp({
      getPort: () => 7894,
      schemaVersion: 1,
      db,
      repoRoot: '/repo',
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
    expect(calls[0]!.context).toMatchObject({
      route: 'POST /api/pr',
      branch: 'feature',
      hunk_count: 1,
    });
  });
});

describe('parsePositiveIntParam', () => {
  it('returns the number for a canonical positive safe integer', () => {
    expect(parsePositiveIntParam('1')).toBe(1);
    expect(parsePositiveIntParam('42')).toBe(42);
    expect(parsePositiveIntParam('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns null for zero, signs, leading zeros, non-decimal forms, padding, and unsafe integers', () => {
    const rejected = [
      '0',
      '-1',
      '+1',
      '01',
      '1.5',
      '1e3',
      '0x1',
      'abc',
      ' 1',
      '1 ',
      '',
      '9007199254740993',
      '99999999999999999999',
    ];
    for (const raw of rejected) expect(parsePositiveIntParam(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('createApp — Host guard', () => {
  it('403s a request whose Host is not loopback', async () => {
    const res = await makeApp().request('http://evil.example:7891/health');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'host not allowed' });
  });

  it('serves 127.0.0.1 and localhost, whatever the case or port', async () => {
    const app = makeApp();
    for (const url of [
      'http://127.0.0.1:7891/health',
      'http://localhost/health',
      'http://LOCALHOST/health',
    ]) {
      expect((await app.request(url)).status, url).toBe(200);
    }
  });

  it('403s, with both headers, a request whose URL cannot be parsed', async () => {
    // HTTP/1.0 with no Host, or a malformed Host, gives a req.url that new URL() rejects.
    const errors: unknown[] = [];
    const app = makeApp({ onError: (err) => errors.push(err) });
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => app.fetch(req) });
    try {
      for (const head of [
        'GET /health HTTP/1.0\r\n',
        'GET /health HTTP/1.1\r\nHost: localhost:99999\r\n',
      ]) {
        const raw = await rawRequest(server.port!, head + 'Connection: close\r\n\r\n');
        expect(raw, head).toMatch(/^HTTP\/1\.1 403/);
        expect(raw).toMatch(/^cache-control: no-store\r$/im);
        expect(raw).toMatch(/^x-content-type-options: nosniff\r$/im);
      }
      expect(errors).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  it('matches the whole hostname, not a prefix or suffix', async () => {
    const app = makeApp();
    for (const host of ['localhost.evil.example', '127.0.0.1.evil.example', 'evil-localhost']) {
      expect((await app.request(`http://${host}/health`)).status, host).toBe(403);
    }
  });

  it('refuses before any route runs: no revision source read, no write', async () => {
    const db = freshDb();
    const app = makeApp({ db });
    await seedRevision(app);

    const read = await app.request('http://evil.example/api/pr/1/rev/1');
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: 'host not allowed' });

    const write = await app.request('http://evil.example/api/pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: 'other',
        base: 'main',
        headSha: 'h',
        baseSha: 'b',
        hunks: [hunk('a.ts', '+a')],
      }),
    });
    expect(write.status).toBe(403);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(1);
  });
});

describe('createApp — response headers', () => {
  it('marks every response no-store and nosniff, redirects and errors included', async () => {
    const app = makeApp();
    await seedRevision(app);
    const closedDb = freshDb();
    const broken = makeApp({ db: closedDb });
    closedDb.close();
    // A throw outside any route's own try reaches app.onError.
    const throwing = makeApp({
      getPort: () => {
        throw new Error('boom');
      },
    });

    const cases: Array<[label: string, send: () => Response | Promise<Response>, status: number]> =
      [
        ['GET /health', () => app.request('/health'), 200],
        ['GET /api/pr/1/rev/1', () => app.request('/api/pr/1/rev/1'), 200],
        ['GET /pr/1', () => app.request('/pr/1'), 302],
        ['GET /pr/1/rev/1', () => app.request('/pr/1/rev/1'), 200],
        ['GET /nope', () => app.request('/nope'), 404],
        ['GET /api/pr/abc/rev/1', () => app.request('/api/pr/abc/rev/1'), 400],
        ['foreign Host', () => app.request('http://evil.example/health'), 403],
        ['route 500', () => broken.request('/api/pr/1/rev/1'), 500],
        ['app.onError 500', () => throwing.request('/health'), 500],
      ];
    for (const [label, send, status] of cases) {
      const res = await send();
      expect(res.status, label).toBe(status);
      expect(res.headers.get('cache-control'), label).toBe('no-store');
      expect(res.headers.get('x-content-type-options'), label).toBe('nosniff');
    }
  });
});

describe('createApp — app.onError', () => {
  it('logs a throw that escapes every route catch with the request method and path', async () => {
    const onError = vi.fn();
    const app = makeApp({
      getPort: () => {
        throw new Error('boom');
      },
      onError,
    });
    const res = await app.request('/health');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error handling request' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { method: 'GET', path: '/health' });
  });
});

describe('createApp — GET /api/pr/:id/rev/:n', () => {
  it('returns the golden view for the golden publish', async () => {
    const app = makeApp({ repoRoot: '/work/demo' });
    await seedRevision(app);
    const res = await app.request('/api/pr/1/rev/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const view = (await res.json()) as RevisionView;
    expect(view).toEqual(GOLDEN_VIEW);
    // `hunks` insertion order is part of the contract: (file_path, start_line, end_line, id).
    expect(Object.keys(view.hunks)).toEqual(Object.keys(GOLDEN_VIEW.hunks));
  });

  it('serves the pinned revision, not the latest', async () => {
    const app = makeApp();
    await seedRevision(app);
    const extra = hunk('lib/extra.ts', '+extra');
    expect(await seedRevision(app, [...GOLDEN_HUNKS, extra])).toMatchObject({
      revision_number: 2,
    });

    const view = (await (await app.request('/api/pr/1/rev/1')).json()) as RevisionView;
    expect(view.revision_number).toBe(1);
    expect(view.latest_revision_number).toBe(2);
    expect(Object.keys(view.hunks).sort()).toEqual(GOLDEN_HUNKS.map((h) => h.id).sort());
    expect(view.chapters.flatMap((c) => c.hunk_ids).sort()).toEqual(
      GOLDEN_HUNKS.map((h) => h.id).sort(),
    );
    expect(JSON.stringify(view)).not.toContain(extra.id);

    const rev2 = (await (await app.request('/api/pr/1/rev/2')).json()) as RevisionView;
    expect(rev2.revision_number).toBe(2);
    expect(Object.keys(rev2.hunks)).toContain(extra.id);
  });

  it('answers 200 with an empty view for a zero-hunk publish', async () => {
    const app = makeApp({ repoRoot: '/work/demo' });
    expect(await seedRevision(app, [])).toMatchObject({ pull_id: 1, revision_number: 1 });
    const res = await app.request('/api/pr/1/rev/1');
    expect(res.status).toBe(200);
    // Same pull and revision as the golden publish, with every hunk-derived field empty.
    expect(await res.json()).toEqual({
      ...GOLDEN_VIEW,
      stats: { additions: 0, deletions: 0, files: 0 },
      authors: [],
      chapters: [],
      hunks: {},
    });
  });

  it('400s a malformed id, checking the pull id before the revision number', async () => {
    const app = makeApp();
    await seedRevision(app);
    const pullIdError = { error: 'pull id must be a positive integer' };
    const revisionError = { error: 'revision number must be a positive integer' };
    const cases: Array<[path: string, body: { error: string }]> = [
      ['/api/pr/abc/rev/xyz', pullIdError],
      ['/api/pr/1/rev/0', revisionError],
      ['/api/pr/01/rev/1', pullIdError],
      ['/api/pr/1/rev/99999999999999999999', revisionError],
    ];
    for (const [path, body] of cases) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      // Exact body: the raw segment is never echoed back.
      expect(await res.json(), path).toEqual(body);
    }
  });

  it('treats MAX_SAFE_INTEGER as a valid id, so a missing pull is 404 not 400', async () => {
    const res = await makeApp().request('/api/pr/9007199254740991/rev/1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'pull 9007199254740991 not found',
      latest_revision_number: null,
    });
  });

  it('accepts a percent-encoded id, which arrives decoded', async () => {
    const app = makeApp();
    await seedRevision(app);
    expect((await app.request('/api/pr/%31/rev/1')).status).toBe(200);
  });

  it('404s a missing pull or revision, always carrying latest_revision_number', async () => {
    const app = makeApp();
    await seedRevision(app);
    await seedRevision(app, [hunk('a.ts', '+a')]);

    const noPull = await app.request('/api/pr/7/rev/1');
    expect(noPull.status).toBe(404);
    expect(await noPull.json()).toEqual({
      error: 'pull 7 not found',
      latest_revision_number: null,
    });

    const noRevision = await app.request('/api/pr/1/rev/9');
    expect(noRevision.status).toBe(404);
    expect(await noRevision.json()).toEqual({
      error: 'revision 9 not found for pull 1',
      latest_revision_number: 2,
    });
  });

  it('404s a pull with no revisions as such, latest null', async () => {
    const db = freshDb();
    insertBarePull(db);
    const res = await makeApp({ db }).request('/api/pr/1/rev/1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'pull 1 has no revisions',
      latest_revision_number: null,
    });
  });

  it('leaves a trailing slash to the default 404', async () => {
    const app = makeApp();
    await seedRevision(app);
    expect((await app.request('/api/pr/1/rev/1/')).status).toBe(404);
  });

  it('answers a logged JSON 500 with the route and ids when the read throws', async () => {
    const db = freshDb();
    const onError = vi.fn();
    const app = makeApp({ db, onError });
    await seedRevision(app);
    db.close();
    const res = await app.request('/api/pr/1/rev/1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error reading revision' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      route: 'GET /api/pr/:id/rev/:n',
      pull_id: 1,
      revision_number: 1,
    });
  });

  it('answers the same logged 500 when building the view throws', async () => {
    const db = freshDb();
    const onError = vi.fn();
    const app = makeApp({ db, onError });
    await seedRevision(app);
    // hunks.content has TEXT affinity, not STRICT: a BLOB reads back as a Uint8Array,
    // which the read passes through and the builder can't split into lines.
    db.run(`UPDATE hunks SET content = X'00'`);
    const res = await app.request('/api/pr/1/rev/1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error reading revision' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      route: 'GET /api/pr/:id/rev/:n',
      pull_id: 1,
      revision_number: 1,
    });
  });
});

describe('createApp — GET /pr/:id', () => {
  it('302s to the latest revision with a relative Location and no body; a deduped re-publish keeps it', async () => {
    const app = makeApp();
    for (const content of ['+1', '+2', '+3']) await seedRevision(app, [hunk('a.ts', content)]);

    const res = await app.request('/pr/1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/pr/1/rev/3');
    expect(await res.text()).toBe('');

    expect(await seedRevision(app, [hunk('a.ts', '+3')])).toMatchObject({ revision_number: 3 });
    expect((await app.request('/pr/1')).headers.get('location')).toBe('/pr/1/rev/3');
  });

  it('404s a missing pull as text/plain', async () => {
    const res = await makeApp().request('/pr/99');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(await res.text()).toBe('pull 99 not found');
  });

  it('400s a malformed id as text/plain', async () => {
    const app = makeApp();
    for (const path of ['/pr/abc', '/pr/0']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get('content-type'), path).toBe('text/plain; charset=UTF-8');
      expect(await res.text(), path).toBe('pull id must be a positive integer');
    }
  });

  it('404s a pull with no revisions the same as a missing pull', async () => {
    const db = freshDb();
    insertBarePull(db);
    const res = await makeApp({ db }).request('/pr/1');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('pull 1 not found');
  });

  it('answers a logged text/plain 500 when the lookup throws', async () => {
    const db = freshDb();
    const onError = vi.fn();
    const app = makeApp({ db, onError });
    await seedRevision(app);
    db.close();
    const res = await app.request('/pr/1');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(await res.text()).toBe('internal error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { route: 'GET /pr/:id', pull_id: 1 });
  });
});

describe('createApp — GET /pr/:id/rev/:n', () => {
  /** Assert the response is the injected page, verbatim, as HTML with `status`. */
  async function expectShell(res: Response, status: number, label: string) {
    expect(res.status, label).toBe(status);
    expect(res.headers.get('content-type'), label).toBe('text/html; charset=UTF-8');
    expect(await res.text(), label).toBe(SHELL);
  }

  it('serves the page with 200 for an existing revision, zero-hunk included', async () => {
    const app = makeApp();
    await seedRevision(app);
    expect(await seedRevision(app, [], 'empty')).toMatchObject({ pull_id: 2, revision_number: 1 });
    await expectShell(await app.request('/pr/1/rev/1'), 200, 'golden');
    await expectShell(await app.request('/pr/2/rev/1'), 200, 'zero-hunk');
  });

  it('serves the page with 404 when the revision or pull is missing', async () => {
    const db = freshDb();
    const app = makeApp({ db });
    await seedRevision(app);
    insertBarePull(db);
    await expectShell(await app.request('/pr/1/rev/2'), 404, 'n past latest');
    await expectShell(await app.request('/pr/99/rev/1'), 404, 'missing pull');
    await expectShell(await app.request('/pr/2/rev/1'), 404, 'pull with no revisions');
  });

  it('serves the page with 400 for a malformed id or revision number', async () => {
    const app = makeApp();
    await seedRevision(app);
    await expectShell(await app.request('/pr/0/rev/1'), 400, '/pr/0/rev/1');
    await expectShell(await app.request('/pr/1/rev/abc'), 400, '/pr/1/rev/abc');
  });

  it('serves the page with 500 and logs once when the lookup throws', async () => {
    const db = freshDb();
    const onError = vi.fn();
    const app = makeApp({ db, onError });
    await seedRevision(app);
    db.close();
    await expectShell(await app.request('/pr/1/rev/1'), 500, 'closed db');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      route: 'GET /pr/:id/rev/:n',
      pull_id: 1,
      revision_number: 1,
    });
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

// End-to-end: spawn the real `reviewdev serve` in a throwaway git repo and
// prove it boots foreground, applies migrations, writes the port file, answers
// /health and the revision routes over HTTP with the real web/index.html,
// refuses a foreign Host, and shuts down cleanly on SIGINT.
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

  it('boots, serves /health and a published revision, refuses a foreign Host, and shuts down cleanly on SIGINT', async () => {
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
    // repo_root identifies which repo this server serves (publish verifies it).
    expect(await res.json()).toEqual({ ok: true, port, schema_version: 2, repo_root: dir });

    // Migrations ran against the per-repo DB.
    expect(existsSync(join(dir, '.reviewdev', 'db.sqlite'))).toBe(true);

    const origin = `http://127.0.0.1:${port}`;
    const published = await fetch(`${origin}/api/pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: GOLDEN_BRANCH,
        base: GOLDEN_BASE,
        headSha: 'h',
        baseSha: 'b',
        hunks: GOLDEN_HUNKS,
      }),
    });
    expect(published.status).toBe(200);

    const latest = await fetch(`${origin}/pr/1`, { redirect: 'manual' });
    expect(latest.status).toBe(302);
    expect(latest.headers.get('location')).toBe('/pr/1/rev/1');

    // The page loaded at startup from web/index.html, not a test shell.
    const page = await fetch(`${origin}/pr/1/rev/1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="panel-01"');

    const view = await fetch(`${origin}/api/pr/1/rev/1`);
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ repo_slug: basename(dir), pull: { id: 1 } });

    // Bun's req.url follows the Host header, so a DNS-rebound request is refused.
    const rebound = await fetch(`${origin}/health`, { headers: { host: 'evil.example' } });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toEqual({ error: 'host not allowed' });

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
        schema_version: 2,
        repo_root: dir,
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

  it('exits 1 before creating .reviewdev/ when the install has no web page', async () => {
    const root = join(dirname(cliPath), '..');
    const install = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-install-')));
    try {
      // A complete install minus web/: the page is the only thing missing.
      cpSync(join(root, 'src'), join(install, 'src'), { recursive: true });
      cpSync(join(root, 'migrations'), join(install, 'migrations'), { recursive: true });
      cpSync(join(root, 'package.json'), join(install, 'package.json'));
      symlinkSync(join(root, 'node_modules'), join(install, 'node_modules'));

      const proc = spawn('bun', [join(install, 'src', 'cli.ts'), 'serve'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr!.on('data', (b) => (stderr += b));
      const code = await new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
      expect(code).toBe(1);
      expect(stderr).toMatch(/web page not found at .*reinstall reviewdev/);
      expect(existsSync(join(dir, '.reviewdev'))).toBe(false);
    } finally {
      rmSync(install, { recursive: true, force: true });
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

/** Send raw bytes over TCP and collect the reply until the server closes. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(request));
    let out = '';
    sock.on('data', (b) => (out += b));
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
}

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
