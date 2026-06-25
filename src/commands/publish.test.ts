import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { resolveDiff, serverHealthy } from './publish.ts';
import type { GitRunner } from '../git.ts';

describe('serverHealthy', () => {
  it('is true when /health on 127.0.0.1 returns {ok:true}', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true, port: 1, schema_version: 1 }),
    });
    try {
      expect(await serverHealthy(server.port!)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it('is false when the body is not ok or the status is an error', async () => {
    const notOk = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: false }),
    });
    const err = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('nope', { status: 500 }),
    });
    try {
      expect(await serverHealthy(notOk.port!)).toBe(false);
      expect(await serverHealthy(err.port!)).toBe(false);
    } finally {
      notOk.stop(true);
      err.stop(true);
    }
  });

  it('is false when nothing is listening on the port', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    const port = server.port!;
    server.stop(true); // free it, then probe the now-dead port
    expect(await serverHealthy(port)).toBe(false);
  });
});

describe('resolveDiff', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-resolve-')));
    mkdirSync(join(dir, '.reviewdev'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('wires base detection, endpoints, and hunk parsing into one payload', () => {
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
        'status --porcelain': '',
        'diff cafe1234..HEAD': diff,
      };
      if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
      return table[key]!;
    }) as GitRunner;

    const payload = resolveDiff({ git, cwd: dir, repoRoot: dir, now: 1_000_000 });
    expect(payload.base).toBe('main');
    expect(payload.headSha).toBe('deadbeef');
    expect(payload.baseSha).toBe('cafe1234');
    expect(payload.dirty).toBe(false);
    expect(payload.hunks).toHaveLength(1);
    expect(payload.hunks[0]!.filePath).toBe('a.ts');
    expect(payload.fetch.fetched).toBe(true);
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

// End-to-end: spawn the real `reviewdev publish` against a throwaway repo.
describe('reviewdev publish (subprocess)', () => {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

  it('exits 1 with the no-server message when serve is not running', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-pub-nosrv-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const proc = spawn('bun', [cliPath, 'publish'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr!.on('data', (b) => (stderr += b));
      const code = await new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
      expect(code).toBe(1);
      expect(stderr).toMatch(/no server for .*\. Run 'reviewdev serve'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the branch diff into hunks against a running server', async () => {
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

      const pub = spawn('bun', [cliPath, 'publish'], {
        cwd: work,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      pub.stdout!.on('data', (b) => (stdout += b));
      pub.stderr!.on('data', (b) => (stderr += b));
      const code = await new Promise<number | null>((r) => pub.once('exit', (c) => r(c)));

      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(stdout).toMatch(/resolved [1-9]\d* hunk\(s\) on this branch vs origin\/main/);
    } finally {
      if (serve && serve.exitCode === null) {
        serve.kill('SIGINT');
        await new Promise((r) => serve!.once('exit', r));
      }
      rmSync(work, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }, 20000);
});

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
