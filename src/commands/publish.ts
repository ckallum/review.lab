import { fail, type CommandHandler } from '../cli.ts';
import { ensureReviewDevDir, fetchMarkerPath, readPortFile, resolveRepoRoot } from '../repo.ts';
import { logLine } from '../log.ts';
import { parseDiff, type ParsedHunk } from '../diff.ts';
import {
  detectBaseBranch,
  diffRange,
  ghBaseRefName,
  makeGitRunner,
  resolveEndpoints,
  throttledFetch,
  workingTreeDirty,
  type FetchResult,
  type GitRunner,
} from '../git.ts';

/**
 * `reviewdev publish` core (T1.4). Resolves the current branch's diff against
 * its base and parses it into content-hashed hunks. Uploading those hunks as a
 * new revision (`POST /api/pr`) and triggering chapter generation land in
 * T1.5+; this ticket stops at the resolved-payload boundary.
 *
 * The pipeline (design.md § Architecture):
 *   resolve repo root → confirm the per-repo server via GET /health →
 *   detect base → throttled `git fetch` → `git diff merge-base..HEAD` →
 *   parse + hash hunks.
 */

/** Everything T1.5 needs to create a revision — the output of the resolve pass.
 * Read-only: it's a snapshot of resolved facts, not a mutable accumulator. */
export interface PublishPayload {
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly hunks: readonly ParsedHunk[];
  readonly dirty: boolean;
  readonly fetch: FetchResult;
}

const HEALTH_TIMEOUT_MS = 2_000; // NFR-1 budgets time-to-URL at 2s; the probe stays well under.

/**
 * Confirm the per-repo server is up on `port`. Connects to `127.0.0.1`, NOT the
 * `localhost` hostname: `serve` binds the IPv4 family specifically (design.md
 * § Security), and `localhost` could resolve to `::1` where nothing listens.
 */
export async function serverHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Run the diff-resolution pipeline. Free of stdout coupling (warnings go
 * through the injected `onWarn`) so T1.5 can reuse it. The fetch and dirty-tree
 * warnings fire *before* `resolveEndpoints`, which can throw on a first publish
 * with no network and no prior base ref — so the user still learns the fetch
 * failure was the upstream cause rather than seeing a bare git error.
 */
export function resolveDiff(deps: {
  git: GitRunner;
  cwd: string;
  repoRoot: string;
  now: number;
  onWarn?: (message: string) => void;
}): PublishPayload {
  const warn = deps.onWarn ?? (() => {});
  const base = detectBaseBranch(deps.git, () => ghBaseRefName(deps.cwd));

  const fetch = throttledFetch({
    git: deps.git,
    base,
    markerPath: fetchMarkerPath(deps.repoRoot),
    now: deps.now,
  });
  if (!fetch.fetched && fetch.reason !== 'throttled') {
    warn('reviewdev: fetch failed, using last-known base');
  }

  const dirty = workingTreeDirty(deps.git);
  if (dirty) warn('reviewdev: uncommitted changes ignored; publishing committed HEAD');

  const { headSha, baseSha } = resolveEndpoints(deps.git, base);
  const hunks = parseDiff(diffRange(deps.git, baseSha));
  return { base, headSha, baseSha, hunks, dirty, fetch };
}

/** `--cwd <path>` defaults to the process cwd; `--session <id>` is accepted now
 * (the skill always passes it, FR-P0.1) and consumed by transcript reading in
 * T3.3. Unknown flags are left for a later pass rather than hard-erroring. */
function parseArgs(args: readonly string[]): { cwd: string; session?: string } {
  let cwd = process.cwd();
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && i + 1 < args.length) cwd = args[++i]!;
    else if (args[i] === '--session' && i + 1 < args.length) session = args[++i]!;
  }
  return { cwd, session };
}

const noServerMessage = (repoRoot: string) =>
  `reviewdev: no server for ${repoRoot}. Run 'reviewdev serve' in this repo first.`;

export const runPublish: CommandHandler = async (args, io) => {
  const { cwd, session } = parseArgs(args);

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd);
  } catch (err) {
    return fail(io, err);
  }

  // The server is the precondition for everything downstream — confirm it
  // before doing any git work, and fail with the actionable SPEC.md message.
  const port = readPortFile(repoRoot);
  if (port === null || !(await serverHealthy(port))) {
    return fail(io, new Error(noServerMessage(repoRoot)));
  }

  let payload: PublishPayload;
  try {
    ensureReviewDevDir(repoRoot);
    payload = resolveDiff({
      git: makeGitRunner(repoRoot),
      cwd,
      repoRoot,
      now: Date.now(),
      onWarn: (message) => io.stderr.write(`${message}\n`),
    });
  } catch (err) {
    return fail(io, err);
  }

  logLine(io, 'publish.resolved', {
    repo_root: repoRoot,
    base: payload.base,
    head_sha: payload.headSha,
    base_sha: payload.baseSha,
    hunk_count: payload.hunks.length,
    dirty: payload.dirty,
    session: session ?? null,
  });

  // T1.5 replaces this human summary with the POST + returned review URL.
  io.stdout.write(
    `resolved ${payload.hunks.length} hunk(s) on this branch vs origin/${payload.base} ` +
      `(merge-base ${payload.baseSha.slice(0, 9)})\n`,
  );
  return 0;
};
