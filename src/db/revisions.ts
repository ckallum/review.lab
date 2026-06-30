import type { Database } from 'bun:sqlite';
import { diffHash, hunkId, type HunkKind, type ParsedHunk } from '../diff.ts';

/**
 * Revision creation + duplicate detection (T1.5) — the write behind
 * `POST /api/pr`. Upserts the pull for the branch, computes the revision's
 * `diff_hash`, and either returns the latest revision unchanged (when the diff
 * is identical) or appends a new immutable revision with its hunks
 * (design.md § Data Model, SPEC.md § Revisions).
 *
 * Server-side only: `serve` owns the single DB handle, so the whole upsert runs
 * in one `BEGIN IMMEDIATE` transaction (design.md § Architecture). The CLI
 * (`publish`) reaches this purely over HTTP.
 */

/** The full `POST /api/pr` payload, validated from the request body. `hunks`
 * IS `ParsedHunk` (camelCase) — `publish` sends its resolved `payload.hunks`
 * straight through, so the wire shape can't drift from the parser's output. */
export interface RevisionInput {
  readonly branch: string;
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly hunks: readonly ParsedHunk[];
}

/** Outcome of a publish. `created` is false when the diff matched the latest
 * revision and no new row was written — the caller returns the existing URL. */
export interface RevisionResult {
  readonly pullId: number;
  readonly revisionNumber: number;
  readonly created: boolean;
}

const HUNK_KINDS: ReadonlySet<string> = new Set<HunkKind>(['add', 'del', 'mod']);

// Upper bound on hunks per publish. A 50-hunk PR is the NFR-1 benchmark and
// even a sweeping refactor stays well under this, so the cap only rejects
// pathological or runaway input. It bounds the row-by-row insert loop and the
// per-hunk validation work — NOT the request body itself, which `c.req.json()`
// has already buffered by the time this runs; fully bounding that would need a
// body-limit middleware, left out as out of the localhost single-user threat
// model.
export const MAX_HUNKS = 10_000;

/**
 * Validate an untrusted `POST /api/pr` body into a `RevisionInput`, throwing a
 * field-named `Error` on the first problem so the route can answer `400` with a
 * message the CLI surfaces — rather than letting a bad shape reach SQLite and
 * fail with an opaque constraint error. Pure and side-effect-free; unit-tested
 * alongside `createRevision`.
 */
export function parseRevisionInput(raw: unknown): RevisionInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object');
  const o = raw as Record<string, unknown>;
  const branch = requireString(o.branch, 'branch');
  const base = requireString(o.base, 'base');
  const headSha = requireString(o.headSha, 'headSha');
  const baseSha = requireString(o.baseSha, 'baseSha');
  if (!Array.isArray(o.hunks)) throw new Error('hunks must be an array');
  // Cap before per-hunk validation so a runaway array is rejected cheaply.
  if (o.hunks.length > MAX_HUNKS)
    throw new Error(`hunks exceeds the ${MAX_HUNKS} cap (got ${o.hunks.length})`);
  const hunks = o.hunks.map((h, i) => parseHunk(h, i));
  return { branch, base, headSha, baseSha, hunks };
}

function parseHunk(raw: unknown, index: number): ParsedHunk {
  if (typeof raw !== 'object' || raw === null) throw new Error(`hunks[${index}] must be an object`);
  const h = raw as Record<string, unknown>;
  const kind = requireString(h.kind, `hunks[${index}].kind`);
  if (!HUNK_KINDS.has(kind))
    throw new Error(`hunks[${index}].kind must be add|del|mod, got '${kind}'`);
  const id = requireString(h.id, `hunks[${index}].id`);
  const filePath = requireString(h.filePath, `hunks[${index}].filePath`);
  // Content may be empty in principle; only the type is constrained.
  const content = requireStringAllowEmpty(h.content, `hunks[${index}].content`);
  // The id is content-addressed (diff.ts § Hunk identity) and feeds both
  // `diff_hash` and cross-revision diffing. Recompute it rather than trusting
  // the wire value: an id that disagrees with its file_path + content would
  // silently corrupt duplicate detection and the revision diff. `reviewdev
  // publish` already sends a matching id; this rejects a malformed or foreign
  // client at the trust boundary instead of persisting a poisoned hash.
  if (hunkId(filePath, content) !== id)
    throw new Error(`hunks[${index}].id does not match its file_path + content hash`);
  return {
    id,
    filePath,
    // Line numbers are 1-based (diff.ts) — reject 0/negatives at the boundary
    // since the INTEGER columns carry no CHECK to catch a foreign client.
    startLine: requirePositiveInt(h.startLine, `hunks[${index}].startLine`),
    endLine: requirePositiveInt(h.endLine, `hunks[${index}].endLine`),
    content,
    kind: kind as HunkKind,
  };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new Error(`${field} must be a non-empty string`);
  return v;
}

function requireStringAllowEmpty(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v;
}

function requirePositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new Error(`${field} must be a positive integer`);
  return v;
}

const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Create (or dedupe) a revision for `input.branch`. Returns the pull id, the
 * resulting revision number, and whether a new revision was written.
 *
 * Duplicate detection (SPEC.md § Revisions): if the new `diff_hash` equals the
 * latest revision's, nothing is written and the latest revision is returned —
 * re-running `publish` without changes can't mint a duplicate revision.
 *
 * Writer invariants enforced here (design.md § Writer invariants):
 * - `hunks.pull_id` is the looked-up/created pull id, never trusted from the
 *   payload, so a hunk can't be filed under a different pull than its revision.
 * - `pulls.updated_at` is bumped on every write that touches the pull (a new
 *   revision, or a duplicate that retargets the branch's base) but NOT on a
 *   pure duplicate with an unchanged base, which performs no write.
 */
export function createRevision(db: Database, input: RevisionInput): RevisionResult {
  // De-dup once, up front: `diff_hash` and the inserted hunk rows must agree on
  // the same set, so they derive from one deduped list rather than two passes.
  const hunks = dedupeById(input.hunks);
  const hash = diffHash(hunks.map((h) => h.id));

  const tx = db.transaction((): RevisionResult => {
    const existing = db
      .query<{ id: number; base: string }, [string]>('SELECT id, base FROM pulls WHERE branch = ?')
      .get(input.branch);

    if (existing) {
      const pullId = existing.id;
      const latest = db
        .query<
          { number: number; diff_hash: string },
          [number]
        >('SELECT number, diff_hash FROM revisions WHERE pull_id = ? ORDER BY number DESC LIMIT 1')
        .get(pullId);

      if (latest && latest.diff_hash === hash) {
        // Duplicate diff → no new revision. But the pull is still upserted by
        // branch: if the branch was retargeted to a different base (same hunks,
        // new base), sync `pulls.base` + `updated_at` so the metadata isn't
        // stale. A same-base re-publish stays a true no-op.
        if (existing.base !== input.base) {
          db.run(`UPDATE pulls SET base = ?, updated_at = ${NOW_SQL} WHERE id = ?`, [
            input.base,
            pullId,
          ]);
        }
        return { pullId, revisionNumber: latest.number, created: false };
      }

      const number = (latest?.number ?? 0) + 1;
      insertRevision(db, pullId, number, hash, input, hunks);
      // The DEFAULT only fires at insert; bump explicitly so the /pulls index
      // (which sorts on updated_at) reflects this publish.
      db.run(`UPDATE pulls SET base = ?, updated_at = ${NOW_SQL} WHERE id = ?`, [
        input.base,
        pullId,
      ]);
      return { pullId, revisionNumber: number, created: true };
    }

    // First publish for this branch: the INSERT's DEFAULTs set created_at /
    // updated_at, so no explicit bump is needed on this path.
    const pull = db
      .query<
        { id: number },
        [string, string]
      >('INSERT INTO pulls (branch, base) VALUES (?, ?) RETURNING id')
      .get(input.branch, input.base)!;
    insertRevision(db, pull.id, 1, hash, input, hunks);
    return { pullId: pull.id, revisionNumber: 1, created: true };
  });

  return tx.immediate();
}

/** Collapse byte-identical hunks (same content-hash id) to a single entry.
 * `hunks` is keyed `(id, revision_id)`, so a diff that repeats an identical
 * block would otherwise hit the primary key; deduping here also keeps the
 * inserted rows aligned with `diff_hash`'s set semantics. */
function dedupeById(hunks: readonly ParsedHunk[]): ParsedHunk[] {
  return [...new Map(hunks.map((h) => [h.id, h])).values()];
}

/** Insert the revision row and its (already-deduped) hunks. */
function insertRevision(
  db: Database,
  pullId: number,
  number: number,
  hash: string,
  input: RevisionInput,
  hunks: readonly ParsedHunk[],
): void {
  const revision = db
    .query<{ id: number }, [number, number, string, string, string]>(
      `INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(pullId, number, input.headSha, input.baseSha, hash)!;

  const insertHunk = db.query(
    `INSERT INTO hunks (id, revision_id, pull_id, file_path, start_line, end_line, content, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const h of hunks) {
    insertHunk.run(
      h.id,
      revision.id,
      pullId,
      h.filePath,
      h.startLine,
      h.endLine,
      h.content,
      h.kind,
    );
  }
}
