import { fail, type CommandHandler } from '../cli.ts';
import {
  ensureReviewDevDir,
  fetchMarkerPath,
  readPortFile,
  resolveRepoRoot,
  serverOrigin,
} from '../repo.ts';
import { logLine } from '../log.ts';
import { parseDiff, type ParsedHunk } from '../diff.ts';
import type { RevisionInput } from '../db/revisions.ts';
import {
  currentBranch,
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
 *   parse + hash hunks → POST /api/pr → print the review URL.
 */

/** Everything needed to create a revision — the output of the resolve pass.
 * Read-only: it's a snapshot of resolved facts, not a mutable accumulator. */
export interface PublishPayload {
  readonly branch: string;
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly hunks: readonly ParsedHunk[];
  readonly dirty: boolean;
  readonly fetch: FetchResult;
}

/** The server's `POST /api/pr` response (design.md § API Design). */
interface PublishResponse {
  readonly pull_id: number;
  readonly revision_number: number;
  readonly url: string;
}

const HEALTH_TIMEOUT_MS = 2_000; // NFR-1 budgets time-to-URL at 2s; the probe stays well under.

/**
 * Outcome of the `/health` preflight. `refused` is the genuine "no server"
 * case — nothing is listening — and gets SPEC.md's "run reviewdev serve"
 * advice. `unhealthy` means a process IS answering but isn't a healthy reviewdev
 * (slow, erroring, or foreign), so the advice differs (#21). `wrong_repo` means
 * a healthy reviewdev answered but serves a DIFFERENT repo — a stale port file
 * pointing at another repo's server; `detail` carries that repo's root.
 */
export type HealthProbe =
  | { healthy: true }
  | { healthy: false; reason: 'refused' | 'timeout' | 'unhealthy' | 'wrong_repo'; detail: string };

/**
 * Probe the per-repo server on `port`, confirming it serves `repoRoot`. Connects
 * to `127.0.0.1`, NOT the `localhost` hostname: `serve` binds the IPv4 family
 * specifically (design.md § Security), and `localhost` could resolve to `::1`
 * where nothing listens.
 *
 * Distinguishes connection-refused (no server) from reachable-but-unhealthy
 * (timeout / non-2xx / bad body) so the caller can give the right remedy
 * instead of telling the user to start a server that's already running (#21).
 * Also rejects a healthy server whose `/health` `repo_root` doesn't match
 * `repoRoot` — a stale port file pointing at another repo's server, which would
 * otherwise let the upload write this repo's diff into the wrong DB.
 */
export async function probeServer(port: number, repoRoot: string): Promise<HealthProbe> {
  let res: Response;
  try {
    res = await fetch(`${serverOrigin(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    // `AbortSignal.timeout` rejects with a DOMException named TimeoutError
    // (AbortError on older runtimes) — the server is up but slow, not absent.
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        healthy: false,
        reason: 'timeout',
        detail: `no response within ${HEALTH_TIMEOUT_MS}ms`,
      };
    }
    // Anything else at the transport layer (ECONNREFUSED on a dead port) is the
    // genuine no-server case.
    return {
      healthy: false,
      reason: 'refused',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) return { healthy: false, reason: 'unhealthy', detail: `HTTP ${res.status}` };
  let body: { ok?: unknown; repo_root?: unknown };
  try {
    body = (await res.json()) as { ok?: unknown; repo_root?: unknown };
  } catch {
    return { healthy: false, reason: 'unhealthy', detail: 'response was not JSON' };
  }
  if (body?.ok !== true)
    return { healthy: false, reason: 'unhealthy', detail: 'health did not report ok' };
  if (body.repo_root !== repoRoot)
    return {
      healthy: false,
      reason: 'wrong_repo',
      detail: typeof body.repo_root === 'string' ? body.repo_root : 'unknown',
    };
  return { healthy: true };
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
  // Injectable gh base-ref lookup (#22). Defaults to the real `gh pr view`
  // shell-out; tests pass a fake to drive the origin/HEAD-unset → gh fallback
  // branch hermetically (the real `ghBaseRefName` would otherwise escape the
  // GitRunner fake and shell out for real).
  ghBaseRef?: () => string | null;
}): PublishPayload {
  const warn = deps.onWarn ?? (() => {});
  const base = detectBaseBranch(deps.git, deps.ghBaseRef ?? (() => ghBaseRefName(deps.cwd)));

  // Not named `fetch` — that would shadow the global `fetch()` this module uses
  // in probeServer, a footgun for any later edit in this scope.
  const fetchResult = throttledFetch({
    git: deps.git,
    base,
    markerPath: fetchMarkerPath(deps.repoRoot),
    now: deps.now,
  });
  if (!fetchResult.fetched && fetchResult.reason !== 'throttled') {
    warn('reviewdev: fetch failed, using last-known base');
  }

  const dirty = workingTreeDirty(deps.git);
  if (dirty) warn('reviewdev: uncommitted changes ignored; publishing committed HEAD');

  const { headSha, baseSha } = resolveEndpoints(deps.git, base);
  const branch = currentBranch(deps.git);
  // Detached HEAD: `currentBranch` yields the literal "HEAD", which would become
  // the `pulls.branch` key — so unrelated detached publishes in one repo would
  // all collide on a single "HEAD" pull. Refuse rather than silently merge them.
  if (branch === 'HEAD') {
    throw new Error('reviewdev: cannot publish from a detached HEAD; check out a branch first');
  }
  const hunks = parseDiff(diffRange(deps.git, baseSha));
  return { branch, base, headSha, baseSha, hunks, dirty, fetch: fetchResult };
}

const UPLOAD_TIMEOUT_MS = 30_000; // Localhost write; generous safety net, not the NFR-1 SLA.

/**
 * POST the resolved diff to the per-repo server, which upserts the pull and
 * creates (or dedupes) a revision (T1.5). The wire shape matches `RevisionInput`
 * — the camelCase payload passes through, so `payload.hunks` needs no remap.
 * Throws a `reviewdev:`-prefixed error on a transport failure or a non-2xx
 * response so `runPublish` surfaces it through the shared `fail` contract.
 */
export async function uploadRevision(
  port: number,
  payload: PublishPayload,
): Promise<PublishResponse> {
  const body: RevisionInput = {
    branch: payload.branch,
    base: payload.base,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    hunks: payload.hunks,
  };

  let res: Response;
  try {
    res = await fetch(`${serverOrigin(port)}/api/pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `reviewdev: failed to upload revision: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const reason = await readErrorReason(res);
    throw new Error(
      `reviewdev: server rejected publish (HTTP ${res.status})${reason ? `: ${reason}` : ''}`,
    );
  }

  // Validate the success body rather than trusting the cast: a malformed or
  // foreign response (e.g. a non-reviewdev process answering the port) would
  // otherwise yield `undefined` fields and print a garbage URL silently.
  const result = (await res.json().catch(() => null)) as PublishResponse | null;
  if (!result || typeof result.url !== 'string') {
    throw new Error('reviewdev: server returned an unexpected publish response');
  }
  return result;
}

/**
 * Extract a human reason from a non-2xx response. The route sends `{ error }`
 * JSON, but a 500 (or a foreign process on the port) may send a bare or
 * non-JSON body — fall back to the raw text so the failure keeps a fingerprint
 * instead of collapsing to "HTTP <status>" with no cause.
 */
async function readErrorReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return text.trim().slice(0, 200);
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

// SPEC.md § Server lifecycle prescribes this verbatim for the genuine
// absent/refused case (the dominant real situation: serve never started).
const noServerMessage = (repoRoot: string) =>
  `reviewdev: no server for ${repoRoot}. Run 'reviewdev serve' in this repo first.`;

// A process IS bound to the port but the probe failed — distinct from "no
// server" so the user isn't told to start one that's already running (#21).
const serverUnreachableMessage = (repoRoot: string, port: number, detail: string) =>
  `reviewdev: server for ${repoRoot} on port ${port} is not responding (${detail}). ` +
  `It may be slow or stuck — check 'reviewdev serve'.`;

// The port file points at a healthy server for a DIFFERENT repo (stale port
// file + port reused by another repo's serve). Refuse rather than write this
// repo's diff into the other repo's DB.
const wrongRepoMessage = (repoRoot: string, port: number, otherRepo: string) =>
  `reviewdev: the server on port ${port} serves a different repo (${otherRepo}); ` +
  `the port file for ${repoRoot} is stale — run 'reviewdev serve' in this repo.`;

export const runPublish: CommandHandler = async (args, io) => {
  const { cwd, session } = parseArgs(args);

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd);
  } catch (err) {
    return fail(io, err);
  }

  // The server is the precondition for everything downstream — confirm it
  // before doing any git work. No port file (or a refused connection) is the
  // genuine no-server case; a reachable-but-unhealthy server gets its own
  // diagnostic so the advice matches reality (#21).
  const port = readPortFile(repoRoot);
  if (port === null) {
    return fail(io, new Error(noServerMessage(repoRoot)));
  }
  const probe = await probeServer(port, repoRoot);
  if (!probe.healthy) {
    let message: string;
    if (probe.reason === 'refused') message = noServerMessage(repoRoot);
    else if (probe.reason === 'wrong_repo')
      message = wrongRepoMessage(repoRoot, port, probe.detail);
    else message = serverUnreachableMessage(repoRoot, port, probe.detail);
    return fail(io, new Error(message));
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

  // Diagnostics go to stderr; publish's stdout is reserved for the result URL
  // (#20) so the skill — and any pipe — reads a single clean value.
  logLine(io.stderr, 'publish.resolved', {
    repo_root: repoRoot,
    branch: payload.branch,
    base: payload.base,
    head_sha: payload.headSha,
    base_sha: payload.baseSha,
    hunk_count: payload.hunks.length,
    dirty: payload.dirty,
    session: session ?? null,
  });

  let result: PublishResponse;
  try {
    result = await uploadRevision(port, payload);
  } catch (err) {
    return fail(io, err);
  }

  logLine(io.stderr, 'publish.uploaded', {
    pull_id: result.pull_id,
    revision_number: result.revision_number,
    url: result.url,
  });

  // The result: the review URL, one line on stdout. The skill opens it.
  io.stdout.write(`${result.url}\n`);
  return 0;
};
