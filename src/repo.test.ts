import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  dbPath,
  ensureReviewDevDir,
  portFilePath,
  readPortFile,
  resolveRepoRoot,
  reviewDevDir,
  serverOrigin,
  writePortFile,
} from './repo.ts';

describe('repo layout paths', () => {
  it('derives the .reviewdev paths under the repo root', () => {
    expect(reviewDevDir('/r')).toBe(join('/r', '.reviewdev'));
    expect(dbPath('/r')).toBe(join('/r', '.reviewdev', 'db.sqlite'));
    expect(portFilePath('/r')).toBe(join('/r', '.reviewdev', 'port'));
  });

  it('builds the loopback origin on the IPv4 address, not localhost', () => {
    // The literal 127.0.0.1 (never `localhost`) is the load-bearing detail —
    // serve binds that family; a hostname could split across ::1.
    expect(serverOrigin(7894)).toBe('http://127.0.0.1:7894');
  });
});

describe('resolveRepoRoot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewdev-repo-'));
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

describe('port file round-trip', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-port-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes then reads back the bound port', () => {
    ensureReviewDevDir(dir);
    writePortFile(dir, 7894);
    expect(readFileSync(portFilePath(dir), 'utf8')).toBe('7894');
    expect(readPortFile(dir)).toBe(7894);
  });

  it('returns null when the port file is missing', () => {
    expect(readPortFile(dir)).toBe(null);
  });

  it('returns null when the port file holds a non-port value', () => {
    ensureReviewDevDir(dir);
    writeFileSync(portFilePath(dir), 'garbage');
    expect(readPortFile(dir)).toBe(null);
  });
});
