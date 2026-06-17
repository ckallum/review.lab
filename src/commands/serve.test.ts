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
  portRangeFromEnv,
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

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port, schema_version: 1 });

    // Migrations ran against the per-repo DB.
    expect(existsSync(join(dir, '.reviewdev', 'db.sqlite'))).toBe(true);

    // SIGINT triggers the graceful shutdown path → exit 0 (not a crash).
    child.kill('SIGINT');
    const code = await new Promise<number | null>((r) => child!.once('exit', (c) => r(c)));
    expect(code).toBe(0);
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
