import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'bun:sqlite';
import { parseDiff } from '../diff.ts';
import { buildRevisionView, type ChapterView } from '../revision-view.ts';
import {
  GOLDEN_BASE,
  GOLDEN_BRANCH,
  GOLDEN_DIFF,
  GOLDEN_REPO_SLUG,
  GOLDEN_SNAPSHOT,
  GOLDEN_VIEW,
} from '../revision-view.fixture.ts';
import { applyMigrations, defaultMigrationsDir, openDb } from './migrate.ts';
import { createRevision, parseRevisionInput, type RevisionResult } from './revisions.ts';
import {
  findRevision,
  latestRevisionNumber,
  readRevisionSnapshot,
  type RevisionSnapshot,
} from './snapshot.ts';

function freshDb(): Database {
  const db = openDb(':memory:');
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

// Seeds through the same validation and writer as `POST /api/pr`.
function publish(
  db: Database,
  diff: string,
  { branch = GOLDEN_BRANCH, headSha = 'head1' }: { branch?: string; headSha?: string } = {},
): RevisionResult {
  return createRevision(
    db,
    parseRevisionInput({
      branch,
      base: GOLDEN_BASE,
      headSha,
      baseSha: 'base1',
      hunks: parseDiff(diff),
    }),
  );
}

// A pull with zero revisions; no writer produces one, so it is a raw INSERT.
function insertBarePull(db: Database): number {
  return db
    .query<
      { id: number },
      []
    >("INSERT INTO pulls (branch, base) VALUES ('empty', 'main') RETURNING id")
    .get()!.id;
}

function snapshotOf(db: Database, pullId: number, n: number): RevisionSnapshot {
  const r = readRevisionSnapshot(db, pullId, n);
  if (!r.ok) throw new Error(`revision ${n} of pull ${pullId}: ${r.lookup.kind}`);
  return r.snapshot;
}

// The read promises rows, not an order; compare row sets.
function canonicalRows(s: RevisionSnapshot) {
  const byKey =
    <T>(key: (row: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : 1;
  return {
    ...s,
    hunks: [...s.hunks].sort(byKey((h) => h.id)),
    chapters: [...s.chapters].sort((a, b) => a.id - b.id),
    chapterHunks: [...s.chapterHunks].sort(byKey((l) => `${l.chapter_id}:${l.hunk_id}`)),
  };
}

// One file, one hunk whose body never changes; only the `@@` start moves. `extra`
// appends further hunk sections to the same file.
const SHIFTING_BODY = [' keep', '-old', '+new', ' tail'];
function shiftedDiff(start: number, extra: readonly string[] = []): string {
  return [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 1111111..2222222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    `@@ -${start},3 +${start},3 @@`,
    ...SHIFTING_BODY,
    ...extra,
    '',
  ].join('\n');
}
const EXTRA_HUNK = ['@@ -40,1 +40,1 @@', '-before', '+after'];

const readmeHunkId = GOLDEN_SNAPSHOT.hunks.find((h) => h.file_path === 'README.md')!.id;

describe('readRevisionSnapshot', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('reads a published revision back into the golden view', () => {
    publish(db, GOLDEN_DIFF);
    const view = buildRevisionView(snapshotOf(db, 1, 1), GOLDEN_REPO_SLUG);
    expect(view).toEqual(GOLDEN_VIEW);
    // The wire order of `hunks` is part of the contract, and toEqual ignores key order.
    expect(Object.keys(view.hunks)).toEqual(Object.keys(GOLDEN_VIEW.hunks));
  });

  it('returns the raw rows the golden snapshot holds, in any order', () => {
    publish(db, GOLDEN_DIFF);
    expect(canonicalRows(snapshotOf(db, 1, 1))).toEqual(canonicalRows(GOLDEN_SNAPSHOT));
  });

  it('scopes hunk rows and chapter links to the requested revision when a hunk hash recurs', () => {
    publish(db, shiftedDiff(10));
    publish(db, shiftedDiff(20, EXTRA_HUNK), { headSha: 'head2' });
    const shared = parseDiff(shiftedDiff(10))[0]!.id;
    expect(parseDiff(shiftedDiff(20, EXTRA_HUNK))[0]!.id).toBe(shared);

    const rev1 = snapshotOf(db, 1, 1);
    const rev2 = snapshotOf(db, 1, 2);
    expect([rev1.revisionNumber, rev1.latestRevisionNumber]).toEqual([1, 2]);
    expect([rev2.revisionNumber, rev2.latestRevisionNumber]).toEqual([2, 2]);
    expect(rev1.chapters).toHaveLength(1);
    expect(rev2.chapters).toHaveLength(1);
    expect(rev1.chapters[0]!.id).not.toBe(rev2.chapters[0]!.id);
    expect(rev1.hunks.map((h) => [h.id, h.start_line])).toEqual([[shared, 10]]);
    expect(rev2.hunks.filter((h) => h.id === shared).map((h) => h.start_line)).toEqual([20]);
    // Each revision's links name only its own chapters, though `hunk_id` alone matches both.
    expect(rev1.chapterHunks).toEqual([
      { chapter_id: rev1.chapters[0]!.id, hunk_id: shared, order: 1 },
    ]);
    const rev2Chapters = new Set(rev2.chapters.map((c) => c.id));
    expect(rev2.chapterHunks).toHaveLength(2);
    expect(rev2.chapterHunks.every((l) => rev2Chapters.has(l.chapter_id))).toBe(true);

    const view1 = buildRevisionView(rev1, GOLDEN_REPO_SLUG);
    const view2 = buildRevisionView(rev2, GOLDEN_REPO_SLUG);
    expect(view1.hunks[shared]!.range_label).toBe('L10-12');
    expect(view2.hunks[shared]!.range_label).toBe('L20-22');
    expect(view1.chapters.map((c) => c.hunk_ids)).toEqual([[shared]]);
    expect(view2.chapters.flatMap((c) => c.hunk_ids)).toContain(shared);
  });

  it('reads by pull id and revision number when revision numbers repeat across pulls', () => {
    publish(db, GOLDEN_DIFF);
    const other = publish(db, shiftedDiff(10), { branch: 'feat/other' });
    const { id } = db
      .query<{ id: number }, [number]>('SELECT id FROM revisions WHERE pull_id = ? AND number = 1')
      .get(other.pullId)!;
    // Row ids (revisions.id, chapters.id) stop matching per-pull numbers once a second pull exists.
    expect(id).not.toBe(1);
    expect(findRevision(db, other.pullId, 1)).toEqual({ kind: 'found', revisionId: id, latest: 1 });

    const s = snapshotOf(db, other.pullId, 1);
    const hunkId = parseDiff(shiftedDiff(10))[0]!.id;
    expect(s.pull.branch).toBe('feat/other');
    expect(s.hunks.map((h) => h.id)).toEqual([hunkId]);
    expect(s.chapters.map((c) => c.order)).toEqual([1]);
    expect(s.chapters[0]!.id).not.toBe(1);
    expect(s.chapterHunks).toEqual([{ chapter_id: s.chapters[0]!.id, hunk_id: hunkId, order: 1 }]);
  });

  it('puts a hunk whose chapter_hunks row is gone into Unchaptered, other chapters as published', () => {
    publish(db, GOLDEN_DIFF);
    db.run('DELETE FROM chapter_hunks WHERE hunk_id = ?', [readmeHunkId]);

    const view = buildRevisionView(snapshotOf(db, 1, 1), GOLDEN_REPO_SLUG);
    const unchaptered: ChapterView = {
      id: 'unchaptered',
      order: 4,
      marker: '§ —',
      title: 'Unchaptered',
      heading: null,
      summary: null,
      active: false,
      read: null,
      read_time: null,
      spans: ['README.md'],
      hunk_ids: [readmeHunkId],
      session: null,
    };
    // The emptied `(root)` chapter drops out; `lib` and `src` are byte-for-byte the golden's.
    expect(view).toEqual({
      ...GOLDEN_VIEW,
      chapters: [GOLDEN_VIEW.chapters[0], GOLDEN_VIEW.chapters[1], unchaptered],
    });
  });
});

describe('findRevision / readRevisionSnapshot misses', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    publish(db, GOLDEN_DIFF);
  });

  it('finds an existing revision with its row id and the latest number', () => {
    const { id } = db
      .query<{ id: number }, []>('SELECT id FROM revisions WHERE pull_id = 1 AND number = 1')
      .get()!;
    expect(findRevision(db, 1, 1)).toEqual({ kind: 'found', revisionId: id, latest: 1 });
  });

  it('reports a missing pull as no-pull', () => {
    expect(findRevision(db, 99, 1)).toEqual({ kind: 'no-pull' });
    expect(readRevisionSnapshot(db, 99, 1)).toEqual({ ok: false, lookup: { kind: 'no-pull' } });
  });

  it('reports a missing revision of an existing pull with the latest number', () => {
    expect(findRevision(db, 1, 5)).toEqual({ kind: 'no-revision', latest: 1 });
    expect(readRevisionSnapshot(db, 1, 5)).toEqual({
      ok: false,
      lookup: { kind: 'no-revision', latest: 1 },
    });
  });

  it('reports a pull with zero revisions as no-revision with latest null', () => {
    const id = insertBarePull(db);
    expect(findRevision(db, id, 1)).toEqual({ kind: 'no-revision', latest: null });
    expect(readRevisionSnapshot(db, id, 1)).toEqual({
      ok: false,
      lookup: { kind: 'no-revision', latest: null },
    });
  });
});

describe('latestRevisionNumber', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('is null for a missing pull', () => {
    expect(latestRevisionNumber(db, 99)).toBeNull();
  });

  it('is null for a pull with zero revisions', () => {
    expect(latestRevisionNumber(db, insertBarePull(db))).toBeNull();
  });

  it('counts distinct publishes and ignores a deduped re-publish', () => {
    publish(db, GOLDEN_DIFF);
    publish(db, shiftedDiff(10), { headSha: 'head2' });
    expect(latestRevisionNumber(db, 1)).toBe(2);

    expect(publish(db, shiftedDiff(10), { headSha: 'head3' }).created).toBe(false);
    expect(latestRevisionNumber(db, 1)).toBe(2);
  });
});
