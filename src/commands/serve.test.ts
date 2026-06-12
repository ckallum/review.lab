import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { applyMigrations, defaultMigrationsDir, openDb } from '../db/migrate.ts';
import {
  PORT_RANGE,
  createApp,
  listenInRange,
  resolveRepoRoot,
  schemaVersion,
  type ServeFn,
} from './serve.ts';

const noopFetch = () => new Response('ok');

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

describe('schemaVersion', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is 0 before any migration runs', () => {
    db.exec('CREATE TABLE meta (version INTEGER PRIMARY KEY, filename TEXT, applied_at TEXT)');
    expect(schemaVersion(db)).toBe(0);
  });

  it('reports the highest applied migration version', () => {
    applyMigrations(db, defaultMigrationsDir());
    expect(schemaVersion(db)).toBe(1);
  });
});

describe('createApp — GET /health', () => {
  it('returns ok, the live port, and schema_version', async () => {
    const app = createApp({ getPort: () => 7893, schemaVersion: 1 });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port: 7893, schema_version: 1 });
  });

  it('reads the port at request time (probe sets it after app construction)', async () => {
    let bound = 0;
    const app = createApp({ getPort: () => bound, schemaVersion: 2 });
    bound = 7895;
    expect(await (await app.request('/health')).json()).toEqual({
      ok: true,
      port: 7895,
      schema_version: 2,
    });
  });

  it('404s an unknown path', async () => {
    const app = createApp({ getPort: () => 7891, schemaVersion: 1 });
    expect((await app.request('/nope')).status).toBe(404);
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

  it('throws a range diagnostic when every port is occupied', () => {
    const range = { start: 7891, end: 7893 };
    const busy = new Set([7891, 7892, 7893]);
    expect(() => listenInRange(noopFetch, fakeServe(busy), range)).toThrow(
      /no free port in 7891-7893/,
    );
  });

  it('propagates a non-address-in-use bind error instead of probing on', () => {
    const serve: ServeFn = (port) => {
      throw new Error(`permission denied binding ${port}`);
    };
    expect(() => listenInRange(noopFetch, serve)).toThrow(/permission denied/);
  });
});

describe('resolveRepoRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewdev-serve-root-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the work-tree root of a git repo', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(resolveRepoRoot(dir)).toBe(realpathSync(dir));
  });

  it('throws when cwd is not inside a git repository', () => {
    // mkdtemp dirs live under the OS temp root, which is not a git work tree.
    expect(() => resolveRepoRoot(dir)).toThrow(/not inside a git repository/);
  });
});

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

  it('boots, writes the port file, and serves /health', async () => {
    child = spawn('bun', [cliPath, 'serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (b) => (stderr += b));

    const portFile = join(dir, '.reviewdev', 'port');
    await waitFor(() => existsSync(portFile), 8000, `port file never appeared. stderr: ${stderr}`);

    const port = Number(readFileSync(portFile, 'utf8').trim());
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE.start);
    expect(port).toBeLessThanOrEqual(PORT_RANGE.end);

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port, schema_version: 1 });

    // Migrations ran against the per-repo DB.
    expect(existsSync(join(dir, '.reviewdev', 'db.sqlite'))).toBe(true);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out: ${message}`);
}
