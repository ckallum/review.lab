import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'bun:sqlite';
import { applyMigrations, defaultMigrationsDir, openDb } from './migrate.ts';
import { createRevision, parseRevisionInput, type RevisionInput } from './revisions.ts';

function freshDb(): Database {
  const db = openDb(':memory:');
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

const hunk = (id: string, file = 'a.ts') =>
  ({ id, filePath: file, startLine: 1, endLine: 2, content: ' a\n+b', kind: 'mod' }) as const;

const input = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  branch: 'feature',
  base: 'main',
  headSha: 'head1',
  baseSha: 'base1',
  hunks: [hunk('h1')],
  ...over,
});

describe('createRevision', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates the pull and revision 1 on first publish', () => {
    const r = createRevision(db, input());
    expect(r).toEqual({ pullId: 1, revisionNumber: 1, created: true });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hunks').get()!.n).toBe(1);
  });

  it('returns the existing revision when the diff_hash matches the latest (dedup)', () => {
    createRevision(db, input());
    // A different head sha but the same hunk set ⇒ same diff_hash ⇒ no new row.
    const again = createRevision(db, input({ headSha: 'head2' }));
    expect(again).toEqual({ pullId: 1, revisionNumber: 1, created: false });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(1);
  });

  it('appends a new revision when the hunk set changes', () => {
    createRevision(db, input());
    const r = createRevision(db, input({ hunks: [hunk('h1'), hunk('h2', 'b.ts')] }));
    expect(r).toEqual({ pullId: 1, revisionNumber: 2, created: true });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(2);
  });

  it('order/repeat of hunks does not split a duplicate into a new revision', () => {
    createRevision(db, input({ hunks: [hunk('h1'), hunk('h2', 'b.ts')] }));
    // Same set, reordered and with a repeat — diff_hash is set-valued, so dedup.
    const again = createRevision(
      db,
      input({ hunks: [hunk('h2', 'b.ts'), hunk('h1'), hunk('h1')] }),
    );
    expect(again.created).toBe(false);
  });

  it('derives hunks.pull_id from the owning pull, never the payload', () => {
    createRevision(db, input());
    const rows = db.query<{ pull_id: number }, []>('SELECT DISTINCT pull_id FROM hunks').all();
    expect(rows).toEqual([{ pull_id: 1 }]);
  });

  it('bumps pulls.updated_at on a new revision but not on a pure duplicate', () => {
    createRevision(db, input());
    const afterFirst = db
      .query<{ updated_at: string }, []>('SELECT updated_at FROM pulls WHERE id = 1')
      .get()!.updated_at;

    // Duplicate → no write → updated_at unchanged.
    createRevision(db, input({ headSha: 'head2' }));
    const afterDup = db
      .query<{ updated_at: string }, []>('SELECT updated_at FROM pulls WHERE id = 1')
      .get()!.updated_at;
    expect(afterDup).toBe(afterFirst);

    // New revision → updated_at bumped (monotonic, never regresses).
    createRevision(db, input({ hunks: [hunk('h9', 'z.ts')] }));
    const afterNew = db
      .query<{ updated_at: string }, []>('SELECT updated_at FROM pulls WHERE id = 1')
      .get()!.updated_at;
    expect(afterNew >= afterFirst).toBe(true);
  });

  it('collapses byte-identical hunks (same content-hash id) into one row', () => {
    createRevision(db, input({ hunks: [hunk('dup'), hunk('dup')] }));
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM hunks').get()!.n).toBe(1);
  });

  it('isolates revisions per branch', () => {
    const a = createRevision(db, input({ branch: 'feature-a' }));
    const b = createRevision(db, input({ branch: 'feature-b' }));
    expect(a.pullId).not.toBe(b.pullId);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pulls').get()!.n).toBe(2);
  });
});

describe('parseRevisionInput', () => {
  const wire = {
    branch: 'feature',
    base: 'main',
    headSha: 'h',
    baseSha: 'b',
    hunks: [
      { id: 'h1', filePath: 'a.ts', startLine: 1, endLine: 2, content: ' a\n+b', kind: 'mod' },
    ],
  };

  it('accepts a well-formed body', () => {
    expect(parseRevisionInput(wire)).toEqual(wire);
  });

  it('accepts an empty hunk set', () => {
    expect(parseRevisionInput({ ...wire, hunks: [] }).hunks).toEqual([]);
  });

  it('rejects a non-object body', () => {
    expect(() => parseRevisionInput(null)).toThrow(/JSON object/);
    expect(() => parseRevisionInput('x')).toThrow(/JSON object/);
  });

  it('names the first missing/blank required field', () => {
    expect(() => parseRevisionInput({ ...wire, branch: '' })).toThrow(/branch must be a non-empty/);
    const { baseSha: _omit, ...noBaseSha } = wire;
    expect(() => parseRevisionInput(noBaseSha)).toThrow(/baseSha must be a non-empty/);
  });

  it('rejects a non-array hunks field', () => {
    expect(() => parseRevisionInput({ ...wire, hunks: {} })).toThrow(/hunks must be an array/);
  });

  it('validates each hunk and names the bad index', () => {
    const badKind = { ...wire, hunks: [{ ...wire.hunks[0], kind: 'replace' }] };
    expect(() => parseRevisionInput(badKind)).toThrow(/hunks\[0\]\.kind must be add\|del\|mod/);
    const badLine = { ...wire, hunks: [{ ...wire.hunks[0], startLine: 1.5 }] };
    expect(() => parseRevisionInput(badLine)).toThrow(/hunks\[0\]\.startLine must be an integer/);
  });
});
