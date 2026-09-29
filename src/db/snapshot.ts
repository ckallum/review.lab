import type { Database } from 'bun:sqlite';
import type { HunkKind } from '../diff.ts';

/**
 * The read behind the revision view routes (T1.9): raw rows for one revision, no
 * shaping. `revision-view.ts` turns a snapshot into the page's JSON, so nearly all
 * mapping logic is testable without a database.
 */

export interface PullRow {
  readonly id: number;
  readonly branch: string;
  readonly base: string;
  readonly title: string | null;
  readonly status: 'open' | 'merged' | 'closed';
}

export interface HunkRow {
  readonly id: string;
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly kind: HunkKind;
  readonly agent: string | null;
  readonly confidence: string;
}

export interface ChapterRow {
  readonly id: number;
  readonly marker: string;
  readonly title: string;
  readonly summary: string | null;
  readonly order: number;
}

export interface ChapterHunkRow {
  readonly chapter_id: number;
  readonly hunk_id: string;
  readonly order: number;
}

export interface RevisionSnapshot {
  readonly pull: PullRow;
  readonly revisionNumber: number;
  readonly latestRevisionNumber: number;
  readonly hunks: readonly HunkRow[];
  readonly chapters: readonly ChapterRow[];
  readonly chapterHunks: readonly ChapterHunkRow[];
}

export type RevisionLookup =
  | { readonly kind: 'found'; readonly revisionId: number; readonly latest: number }
  | { readonly kind: 'no-pull' }
  | { readonly kind: 'no-revision'; readonly latest: number | null };

export type MissingRevision = Exclude<RevisionLookup, { kind: 'found' }>;

/** Highest revision number for a pull, or null when the pull is missing or has none. */
export function latestRevisionNumber(db: Database, pullId: number): number | null {
  const row = db
    .query<
      { n: number | null },
      [number]
    >('SELECT MAX(number) AS n FROM revisions WHERE pull_id = ?')
    .get(pullId);
  return row?.n ?? null;
}

/** Locate revision `n` of pull `pullId`, distinguishing a missing pull from a missing revision. */
export function findRevision(db: Database, pullId: number, n: number): RevisionLookup {
  const pull = db.query<{ id: number }, [number]>('SELECT id FROM pulls WHERE id = ?').get(pullId);
  if (!pull) return { kind: 'no-pull' };
  const latest = latestRevisionNumber(db, pullId);
  const rev = db
    .query<
      { id: number },
      [number, number]
    >('SELECT id FROM revisions WHERE pull_id = ? AND number = ?')
    .get(pullId, n);
  if (!rev || latest === null) return { kind: 'no-revision', latest };
  return { kind: 'found', revisionId: rev.id, latest };
}

/**
 * Read every row the view needs for revision `n` of pull `pullId`.
 *
 * - One deferred transaction, so a concurrent writer can't be seen half done
 *   between the chapters and chapter_hunks SELECTs.
 * - chapter_hunks is joined through `chapters.revision_id` (design.md § Writer
 *   invariants): a content hash can recur across revisions, so `hunk_id` alone
 *   doesn't identify this revision's row.
 * - Rows come back unordered; `buildRevisionView` imposes the canonical order.
 */
export function readRevisionSnapshot(
  db: Database,
  pullId: number,
  n: number,
): { ok: true; snapshot: RevisionSnapshot } | { ok: false; lookup: MissingRevision } {
  const read = db.transaction(() => {
    const lookup = findRevision(db, pullId, n);
    if (lookup.kind !== 'found') return { ok: false as const, lookup };
    const pull = db
      .query<PullRow, [number]>('SELECT id, branch, base, title, status FROM pulls WHERE id = ?')
      .get(pullId)!;
    const hunks = db
      .query<HunkRow, [number]>(
        `SELECT id, file_path, start_line, end_line, content, kind, agent, confidence
         FROM hunks WHERE revision_id = ?`,
      )
      .all(lookup.revisionId);
    const chapters = db
      .query<
        ChapterRow,
        [number]
      >('SELECT id, marker, title, summary, "order" FROM chapters WHERE revision_id = ?')
      .all(lookup.revisionId);
    const chapterHunks = db
      .query<ChapterHunkRow, [number]>(
        `SELECT ch.chapter_id, ch.hunk_id, ch."order" FROM chapter_hunks ch
         JOIN chapters c ON c.id = ch.chapter_id WHERE c.revision_id = ?`,
      )
      .all(lookup.revisionId);
    const snapshot: RevisionSnapshot = {
      pull,
      revisionNumber: n,
      latestRevisionNumber: lookup.latest,
      hunks,
      chapters,
      chapterHunks,
    };
    return { ok: true as const, snapshot };
  });
  return read.deferred();
}
