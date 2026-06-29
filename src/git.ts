import { execFileSync } from 'node:child_process';
import { statSync, utimesSync, writeFileSync } from 'node:fs';

/**
 * Git operations for `reviewdev publish` (T1.4). Every git call goes through a
 * `GitRunner` so the diff-resolution logic (base detection, fetch throttle,
 * merge-base) can be unit-tested with a fake instead of a real repository —
 * the same seam `serve` uses for its port probe. `makeGitRunner` is the real
 * implementation; tests pass their own.
 */

/** Runs a git subcommand and returns trimmed stdout; throws on non-zero exit. */
export type GitRunner = (args: readonly string[], opts?: { timeoutMs?: number }) => string;

export function makeGitRunner(cwd: string): GitRunner {
  return (args, opts) =>
    execFileSync('git', args as string[], {
      cwd,
      encoding: 'utf8',
      // Capture stderr (don't inherit) so a failure's reason rides on the
      // thrown error instead of leaking to the user's console.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs,
    }).trim();
}

const FETCH_TIMEOUT_MS = 10_000; // SPEC.md § Failure modes: 10s, then stale base.
export const FETCH_THROTTLE_MS = 60_000; // SPEC.md § Diff source: skip if < 60s ago.

/**
 * Auto-detect the base branch (SPEC.md § Diff source), in order:
 *   1. `origin/HEAD` symbolic-ref — the remote's default branch.
 *   2. `gh pr view --json baseRefName` — the open PR's actual base, if any.
 *   3. `main`, else `master` — whichever has a remote-tracking ref.
 * Returns the bare branch name (no `origin/` prefix).
 */
export function detectBaseBranch(git: GitRunner, ghBaseRef: () => string | null): string {
  try {
    // e.g. "origin/main" → "main".
    const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  } catch {
    // origin/HEAD unset (common after a bare-pushed or shallow clone) — fall through.
  }

  const fromGh = ghBaseRef();
  if (fromGh) return fromGh;

  // Plain defaults, preferring whichever the remote actually has so the later
  // merge-base doesn't fail on a guessed name.
  if (!remoteRefExists(git, 'main') && remoteRefExists(git, 'master')) return 'master';
  return 'main';
}

function remoteRefExists(git: GitRunner, branch: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort `gh pr view --json baseRefName`; null if gh is missing/unauthed. */
export function ghBaseRefName(cwd: string): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', '--json', 'baseRefName', '-q', '.baseRefName'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Discriminated so a non-fetch always carries a reason ('throttled' or the
// error message): callers can branch on `fetched` without a possibly-undefined
// reason silently swallowing a real failure warning.
export type FetchResult = { fetched: true } | { fetched: false; reason: string };

/**
 * `git fetch origin <base>`, throttled: skipped when the marker file was
 * touched under `throttleMs` ago (SPEC.md § Diff source). A fetch failure is
 * non-fatal — publish continues against the last-known base (SPEC.md § Failure
 * modes) — so the caller surfaces `reason` as a warning rather than aborting.
 * `now` is injected for deterministic tests.
 */
export function throttledFetch(args: {
  git: GitRunner;
  base: string;
  markerPath: string;
  now: number;
  throttleMs?: number;
}): FetchResult {
  const { git, base, markerPath, now, throttleMs = FETCH_THROTTLE_MS } = args;

  try {
    const ageMs = now - statSync(markerPath).mtimeMs;
    if (ageMs >= 0 && ageMs < throttleMs) return { fetched: false, reason: 'throttled' };
  } catch {
    // No marker yet (first publish) — fall through and fetch.
  }

  try {
    git(['fetch', 'origin', base], { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err) {
    return { fetched: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // The fetch succeeded — that's the result. Stamping the throttle marker is a
  // best-effort optimisation; if the write fails (full disk, perms) just skip
  // it rather than failing a publish whose diff is already current.
  try {
    touch(markerPath, now);
  } catch {
    // Non-fatal: the next publish simply won't see the throttle and re-fetches.
  }
  return { fetched: true };
}

/** Create-or-update the marker and stamp its mtime to `now` (injected clock). */
function touch(markerPath: string, now: number): void {
  writeFileSync(markerPath, '');
  const seconds = now / 1000;
  utimesSync(markerPath, seconds, seconds);
}

/**
 * The diff endpoints: HEAD and its merge-base with `origin/<base>`. Diffing
 * `merge-base..HEAD` (not `origin/base..HEAD`) keeps changes merged *from* the
 * base out of the authored set (SPEC.md § Diff source). Throws if there is no
 * common ancestor or the remote-tracking ref is missing.
 */
export function resolveEndpoints(
  git: GitRunner,
  base: string,
): { headSha: string; baseSha: string } {
  const headSha = git(['rev-parse', 'HEAD']);
  const baseSha = git(['merge-base', 'HEAD', `origin/${base}`]);
  return { headSha, baseSha };
}

/** `git diff <baseSha>..HEAD` — the committed delta to publish. */
export function diffRange(git: GitRunner, baseSha: string): string {
  return git(['diff', `${baseSha}..HEAD`]);
}

/** The current branch name — the key the server upserts a `pull` under (T1.5).
 * Returns the literal `HEAD` on a detached checkout (what `--abbrev-ref` emits
 * rather than throwing); `resolveDiff` rejects that value so unrelated detached
 * publishes can't collide on one shared "HEAD" pull. */
export function currentBranch(git: GitRunner): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** True when the working tree has uncommitted changes (publish warns, uses HEAD). */
export function workingTreeDirty(git: GitRunner): boolean {
  return git(['status', '--porcelain']).length > 0;
}
