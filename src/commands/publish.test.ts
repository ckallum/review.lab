import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { probeServer, resolveDiff, uploadRevision, type PublishPayload } from './publish.ts';
import { openDb } from '../db/migrate.ts';
import { dbPath, ensureReviewDevDir, writePortFile } from '../repo.ts';
import type { GitRunner } from '../git.ts';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

describe('probeServer', () => {
  it('is healthy when /health on 127.0.0.1 returns {ok:true}', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true, port: 1, schema_version: 1 }),
    });
    try {
      expect(await probeServer(server.port!)).toEqual({ healthy: true });
    } finally {
      server.stop(true);
    }
  });

  // #21: a process is answering, so the result is "unhealthy", never "refused" —
  // the caller must not tell the user to start a server that's already running.
  it('reports unhealthy (not refused) when the server answers but ok!==true', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: false }),
    });
    try {
      expect(await probeServer(server.port!)).toMatchObject({
        healthy: false,
        reason: 'unhealthy',
      });
    } finally {
      server.stop(true);
    }
  });

  it('reports unhealthy with the status on a non-2xx response', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('boom', { status: 500 }),
    });
    try {
      expect(await probeServer(server.port!)).toEqual({
        healthy: false,
        reason: 'unhealthy',
        detail: 'HTTP 500',
      });
    } finally {
      server.stop(true);
    }
  });

  it('reports unhealthy when the body is not JSON (foreign process on the port)', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('plain text', { status: 200 }),
    });
    try {
      expect(await probeServer(server.port!)).toMatchObject({
        healthy: false,
        reason: 'unhealthy',
      });
    } finally {
      server.stop(true);
    }
  });

  it('reports refused when nothing is listening on the port', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    const port = server.port!;
    server.stop(true); // free it, then probe the now-dead port
    expect(await probeServer(port)).toMatchObject({ healthy: false, reason: 'refused' });
  });

  it('reports timeout when the server is reachable but never answers', async () => {
    // A handler that never resolves → AbortSignal.timeout fires → 'timeout',
    // distinct from a dead port's 'refused'.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      expect(await probeServer(server.port!)).toMatchObject({ healthy: false, reason: 'timeout' });
    } finally {
      server.stop(true);
    }
  }, 6000);
});

describe('resolveDiff', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-resolve-')));
    mkdirSync(join(dir, '.reviewdev'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('wires base, branch, endpoints, and hunk parsing into one payload', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
      '',
    ].join('\n');
    const git = ((args: readonly string[]) => {
      const key = args.join(' ');
      const table: Record<string, string> = {
        'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
        'fetch origin main': '',
        'rev-parse HEAD': 'deadbeef',
        'merge-base HEAD origin/main': 'cafe1234',
        'rev-parse --abbrev-ref HEAD': 'feature',
        'status --porcelain': '',
        'diff cafe1234..HEAD': diff,
      };
      if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
      return table[key]!;
    }) as GitRunner;

    const payload = resolveDiff({ git, cwd: dir, repoRoot: dir, now: 1_000_000 });
    expect(payload.base).toBe('main');
    expect(payload.branch).toBe('feature');
    expect(payload.headSha).toBe('deadbeef');
    expect(payload.baseSha).toBe('cafe1234');
    expect(payload.dirty).toBe(false);
    expect(payload.hunks).toHaveLength(1);
    expect(payload.hunks[0]!.filePath).toBe('a.ts');
    expect(payload.fetch.fetched).toBe(true);
  });

  // #22: origin/HEAD is unset, so detection falls through to the injected gh
  // lookup. Driving that branch hermetically is exactly what the seam unlocks —
  // the real ghBaseRefName would otherwise shell out past the GitRunner fake.
  it('falls back to the injected gh base-ref when origin/HEAD is unset', () => {
    const git = ((args: readonly string[]) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD')
        throw new Error('no origin/HEAD');
      if (key === 'fetch origin develop') return '';
      if (key === 'status --porcelain') return '';
      if (key === 'rev-parse HEAD') return 'h';
      if (key === 'merge-base HEAD origin/develop') return 'b';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'feature';
      if (key === 'diff b..HEAD') return '';
      throw new Error(`unexpected git call: ${key}`);
    }) as GitRunner;

    const payload = resolveDiff({
      git,
      cwd: dir,
      repoRoot: dir,
      now: 1_000_000,
      ghBaseRef: () => 'develop',
    });
    expect(payload.base).toBe('develop');
  });

  it('warns (before the throwing endpoints step) on a failed fetch and a dirty tree', () => {
    const warnings: string[] = [];
    const git = ((args: readonly string[]) => {
      const key = args.join(' ');
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key === 'fetch origin main') throw new Error('network down');
      if (key === 'status --porcelain') return ' M src/a.ts';
      if (key === 'rev-parse HEAD') return 'h';
      if (key === 'merge-base HEAD origin/main') return 'b';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'feature';
      if (key === 'diff b..HEAD') return '';
      throw new Error(`unexpected git call: ${key}`);
    }) as GitRunner;

    const payload = resolveDiff({
      git,
      cwd: dir,
      repoRoot: dir,
      now: 1_000_000,
      onWarn: (m) => warnings.push(m),
    });
    expect(payload.dirty).toBe(true);
    expect(payload.fetch.fetched).toBe(false);
    expect(warnings).toEqual([
      'reviewdev: fetch failed, using last-known base',
      'reviewdev: uncommitted changes ignored; publishing committed HEAD',
    ]);
  });
});

describe('uploadRevision', () => {
  const payload: PublishPayload = {
    branch: 'feature',
    base: 'main',
    headSha: 'h',
    baseSha: 'b',
    hunks: [
      { id: 'abc', filePath: 'a.ts', startLine: 1, endLine: 2, content: ' a\n+b', kind: 'mod' },
    ],
    dirty: false,
    fetch: { fetched: true },
  };

  it('POSTs the payload and returns the server response', async () => {
    let seen: unknown;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        seen = await req.json();
        return Response.json({ pull_id: 1, revision_number: 1, url: 'http://x/pr/1/rev/1' });
      },
    });
    try {
      const res = await uploadRevision(server.port!, payload);
      expect(res).toEqual({ pull_id: 1, revision_number: 1, url: 'http://x/pr/1/rev/1' });
      expect(seen).toMatchObject({ branch: 'feature', base: 'main', headSha: 'h', baseSha: 'b' });
    } finally {
      server.stop(true);
    }
  });

  it("surfaces the server's error reason on a non-2xx response", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ error: 'branch must be a non-empty string' }, { status: 400 }),
    });
    try {
      await expect(uploadRevision(server.port!, payload)).rejects.toThrow(
        /server rejected publish \(HTTP 400\): branch must be a non-empty string/,
      );
    } finally {
      server.stop(true);
    }
  });

  it('falls back to the raw text body when a non-2xx error is not JSON', async () => {
    // An opaque 500 (or foreign process) without a `{ error }` body must still
    // carry a fingerprint, not collapse to a bare "HTTP 500".
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('boom not json', { status: 500 }),
    });
    try {
      await expect(uploadRevision(server.port!, payload)).rejects.toThrow(
        /server rejected publish \(HTTP 500\): boom not json/,
      );
    } finally {
      server.stop(true);
    }
  });

  it('rejects a 2xx response whose body is missing the url', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ pull_id: 1, revision_number: 1 }),
    });
    try {
      await expect(uploadRevision(server.port!, payload)).rejects.toThrow(
        /unexpected publish response/,
      );
    } finally {
      server.stop(true);
    }
  });
});

// End-to-end: spawn the real `reviewdev publish` against a throwaway repo.
describe('reviewdev publish (subprocess)', () => {
  it('exits 1 with the no-server message when serve is not running', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-pub-nosrv-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const { code, stderr } = await runPublish(dir);
      expect(code).toBe(1);
      expect(stderr).toMatch(/no server for .*\. Run 'reviewdev serve'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #21: a process is bound to the port file's port but isn't a healthy
  // reviewdev → distinct "not responding" diagnostic, not the "no server" lie.
  it('reports an unreachable server (not "no server") when the port is bound but unhealthy', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-pub-unhealthy-')));
    const bad = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('boom', { status: 500 }),
    });
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      ensureReviewDevDir(dir);
      writePortFile(dir, bad.port!);
      const { code, stderr } = await runPublish(dir);
      expect(code).toBe(1);
      expect(stderr).toMatch(/on port \d+ is not responding \(HTTP 500\)/);
      expect(stderr).not.toMatch(/Run 'reviewdev serve'/);
    } finally {
      bad.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes a revision, prints its URL, and dedupes an unchanged re-publish', async () => {
    const { work, origin } = setupRepoWithRemote();
    let serve: ReturnType<typeof spawn> | undefined;
    try {
      serve = spawn('bun', [cliPath, 'serve'], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
      let serveErr = '';
      serve.stderr!.on('data', (b) => (serveErr += b));
      const portFile = join(work, '.reviewdev', 'port');
      await waitFor(
        () => existsSync(portFile),
        8000,
        () => `serve never wrote port. stderr: ${serveErr}`,
      );

      const first = await runPublish(work);
      expect(first.code, `stderr: ${first.stderr}`).toBe(0);
      expect(first.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pr\/\d+\/rev\/1$/);
      // Diagnostics belong on stderr (#20) — stdout is the URL alone.
      expect(first.stdout.trim().split('\n')).toHaveLength(1);

      // The revision, its pull, and the feature hunks landed in the DB.
      assertDb(work, (db) => {
        expect(count(db, 'SELECT COUNT(*) AS n FROM revisions')).toBe(1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM hunks')).toBeGreaterThan(0);
        const pull = db
          .query<{ branch: string; base: string }, []>('SELECT branch, base FROM pulls')
          .get();
        expect(pull).toEqual({ branch: 'feature', base: 'main' });
      });

      // Re-publish with no new commits → same URL, no second revision (dedup).
      const second = await runPublish(work);
      expect(second.code, `stderr: ${second.stderr}`).toBe(0);
      expect(second.stdout.trim()).toBe(first.stdout.trim());
      assertDb(work, (db) => expect(count(db, 'SELECT COUNT(*) AS n FROM revisions')).toBe(1));
    } finally {
      if (serve && serve.exitCode === null) {
        serve.kill('SIGINT');
        await new Promise((r) => serve!.once('exit', r));
      }
      rmSync(work, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }, 30000);
});

function runPublish(cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawn('bun', [cliPath, 'publish'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (b) => (stdout += b));
  proc.stderr!.on('data', (b) => (stderr += b));
  return new Promise((r) => proc.once('exit', (code) => r({ code, stdout, stderr })));
}

/** Open the repo's DB read-only-ish for assertions, then always close it.
 * WAL mode lets this second connection read alongside serve's writer. */
function assertDb(repoRoot: string, check: (db: ReturnType<typeof openDb>) => void): void {
  const db = openDb(dbPath(repoRoot));
  try {
    check(db);
  } finally {
    db.close();
  }
}

function count(db: ReturnType<typeof openDb>, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()!.n;
}

/** A work repo with an `origin` bare remote, a `main` branch, origin/HEAD set,
 * and a `feature` branch carrying one commit of real changes to diff. */
function setupRepoWithRemote(): { work: string; origin: string } {
  const origin = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-origin-')));
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-work-')));
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  g(origin, 'init', '--bare', '-q');
  g(work, 'init', '-q');
  g(work, 'config', 'user.email', 'test@example.com');
  g(work, 'config', 'user.name', 'Test');
  g(work, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(work, 'README.md'), 'hello\nworld\n');
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'init');
  g(work, 'branch', '-M', 'main');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');
  g(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  g(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'README.md'), 'hello\nbrave\nworld\n');
  writeFileSync(join(work, 'feature.ts'), 'export const x = 1;\n');
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'feature work');
  return { work, origin };
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
  throw new Error(`waitFor timed out: ${message()}`);
}
