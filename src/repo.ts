import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-repo on-disk layout. reviewdev keeps one SQLite DB and one port file
 * under `<repo-root>/.reviewdev/` (design.md § Architecture). Centralised here
 * so `serve` and `publish` derive identical paths instead of each re-spelling
 * the `.reviewdev` / `db.sqlite` / `port` literals — a typo would otherwise
 * fail silently at runtime with no compile error.
 */

/**
 * Resolve the enclosing git repository root for `cwd`. reviewdev is cwd-rooted.
 * Throws if `cwd` isn't inside a git work tree, distinguishing a missing git
 * binary (`ENOENT`) from a non-repo and surfacing git's own stderr reason
 * (e.g. "dubious ownership", common in worktrees/containers).
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
      throw new Error('reviewdev: git not found on PATH', { cause: err });
    }
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim();
    throw new Error(
      `reviewdev: ${cwd} is not inside a git repository${stderr ? ` (${stderr})` : ''}`,
      { cause: err },
    );
  }
}

export function reviewDevDir(repoRoot: string): string {
  return join(repoRoot, '.reviewdev');
}

export function dbPath(repoRoot: string): string {
  return join(reviewDevDir(repoRoot), 'db.sqlite');
}

export function portFilePath(repoRoot: string): string {
  return join(reviewDevDir(repoRoot), 'port');
}

/**
 * Marker file recording when `publish` last ran `git fetch` for this repo.
 * Its mtime drives the 60-second fetch throttle (SPEC.md § Diff source) so
 * back-to-back publishes don't each pay the network round-trip.
 */
export function fetchMarkerPath(repoRoot: string): string {
  return join(reviewDevDir(repoRoot), 'last-fetch');
}

/** Create `<repo>/.reviewdev/` if missing; returns its path. */
export function ensureReviewDevDir(repoRoot: string): string {
  const dir = reviewDevDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writePortFile(repoRoot: string, port: number): void {
  writeFileSync(portFilePath(repoRoot), String(port));
}

/**
 * Read the bound port `serve` recorded, or null if the file is missing or not a
 * valid port. `publish` (T1.4) reads this to find the per-repo server — keeping
 * the trim/parse/validate in one place so both sides agree.
 */
export function readPortFile(repoRoot: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(portFilePath(repoRoot), 'utf8');
  } catch {
    return null;
  }
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
