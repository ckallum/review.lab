import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  applyMigrations,
  currentVersion,
  defaultMigrationsDir,
  latestMigrationVersion,
  listMigrations,
  openDb,
} from './migrate.ts';

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

// PRAGMA arguments can't be bound parameters in SQLite, so the table name
// has to be interpolated. Every current caller passes a hard-coded literal,
// but reject anything that isn't a plain SQL identifier so future callers
// can't accidentally pass user-derived input through the helper.
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function columns(db: Database, table: string): string[] {
  if (!SQL_IDENTIFIER.test(table)) {
    throw new Error(`columns: invalid table identifier '${table}'`);
  }
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
}

function seedPullAndRevision(db: Database, branch = 'feat/x'): { pullId: number; revId: number } {
  const pullId = Number(
    db.run('INSERT INTO pulls (branch, base) VALUES (?, ?)', [branch, 'main']).lastInsertRowid,
  );
  const revId = Number(
    db.run(
      'INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash) VALUES (?, ?, ?, ?, ?)',
      [pullId, 1, 'h', 'b', 'd'],
    ).lastInsertRowid,
  );
  return { pullId, revId };
}

describe('listMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewdev-mig-list-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns numbered files in version order', () => {
    writeFileSync(join(dir, '010_b.sql'), '');
    writeFileSync(join(dir, '002_a.sql'), '');
    writeFileSync(join(dir, '001_initial.sql'), '');
    expect(listMigrations(dir).map((m) => m.version)).toEqual([1, 2, 10]);
  });

  it('skips files that do not match NNN_<slug>.sql', () => {
    writeFileSync(join(dir, '001_initial.sql'), '');
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'rollback.sh'), '');
    writeFileSync(join(dir, '02_missing_pad.sql'), ''); // OK — leading 02 still numeric
    expect(listMigrations(dir).map((m) => m.filename)).toEqual([
      '001_initial.sql',
      '02_missing_pad.sql',
    ]);
  });

  it('throws a diagnostic when two files share the same version', () => {
    writeFileSync(join(dir, '001_initial.sql'), '');
    writeFileSync(join(dir, '001_dup.sql'), '');
    expect(() => listMigrations(dir)).toThrow(
      /duplicate migration version 1 in '001_dup\.sql' and '001_initial\.sql'/,
    );
  });
});

describe('applyMigrations against the real 001_initial.sql', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the meta table and applies 001_initial.sql', () => {
    const ran = applyMigrations(db, defaultMigrationsDir());

    expect(ran.map((m) => m.version)).toEqual([1]);
    expect(ran[0]!.filename).toBe('001_initial.sql');
    expect(ran[0]!.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = db
      .query<{ version: number; filename: string }, []>('SELECT version, filename FROM meta')
      .all();
    expect(after).toEqual([{ version: 1, filename: '001_initial.sql' }]);
  });

  it('lands every table from design.md plus the meta tracker', () => {
    applyMigrations(db, defaultMigrationsDir());
    expect(tables(db)).toEqual([
      'approvals',
      'chapter_hunks',
      'chapters',
      'comments',
      'decisions',
      'hunks',
      'meta',
      'pulls',
      'revisions',
      'sessions',
      'usage',
    ]);
  });

  it('lands the load-bearing columns on each table', () => {
    applyMigrations(db, defaultMigrationsDir());
    expect(columns(db, 'pulls')).toContain('branch');
    expect(columns(db, 'pulls')).toContain('github_url');
    expect(columns(db, 'revisions')).toContain('diff_hash');
    expect(columns(db, 'hunks')).toContain('confidence');
    expect(columns(db, 'hunks')).toContain('generated');
    expect(columns(db, 'chapters')).toContain('inherited_from_chapter_id');
    expect(columns(db, 'sessions')).toContain('parent_session_id');
    expect(columns(db, 'sessions')).toContain('compacted');
    expect(columns(db, 'usage')).toContain('cost_usd');
  });

  it('is idempotent — re-running does not re-apply or insert duplicates', () => {
    const first = applyMigrations(db, defaultMigrationsDir());
    const second = applyMigrations(db, defaultMigrationsDir());
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    const metaCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM meta').get()!.c;
    expect(metaCount).toBe(1);
  });

  it('enforces foreign keys after openDb (WAL is untestable on :memory:)', () => {
    applyMigrations(db, defaultMigrationsDir());
    // `:memory:` databases report `memory` for journal_mode regardless of PRAGMA;
    // assert foreign_keys instead, which round-trips on memory DBs.
    const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys;
    expect(fk).toBe(1);
  });

  it('enforces FK constraints — orphan revision rejected', () => {
    applyMigrations(db, defaultMigrationsDir());
    expect(() =>
      db.run(
        'INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash) VALUES (?, ?, ?, ?, ?)',
        [999, 1, 'sha-head', 'sha-base', 'sha-diff'],
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('lets the same hunk content-hash live in multiple revisions (composite PK)', () => {
    applyMigrations(db, defaultMigrationsDir());

    const { pullId, revId: rev1 } = seedPullAndRevision(db);
    const rev2 = Number(
      db.run(
        'INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash) VALUES (?, ?, ?, ?, ?)',
        [pullId, 2, 'h2', 'b2', 'd2'],
      ).lastInsertRowid,
    );

    const insertHunk = (revisionId: number) =>
      db.run(
        `INSERT INTO hunks (id, revision_id, pull_id, file_path, start_line, end_line, content, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['hash-abc', revisionId, pullId, 'src/foo.ts', 10, 12, '+x;', 'add'],
      );

    expect(() => insertHunk(rev1)).not.toThrow();
    expect(() => insertHunk(rev2)).not.toThrow();

    const count = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM hunks WHERE id = 'hash-abc'`)
      .get()!.c;
    expect(count).toBe(2);
  });

  it('enforces enum CHECK on pulls.status and comments.target_kind', () => {
    applyMigrations(db, defaultMigrationsDir());

    expect(() =>
      db.run('INSERT INTO pulls (branch, base, status) VALUES (?, ?, ?)', [
        'feat/z',
        'main',
        'bogus',
      ]),
    ).toThrow(/CHECK constraint failed/);

    const { pullId, revId } = seedPullAndRevision(db, 'feat/zz');
    expect(() =>
      db.run(
        'INSERT INTO comments (revision_id, pull_id, target_kind, target_id, body) VALUES (?, ?, ?, ?, ?)',
        [revId, pullId, 'invalid', 'x', 'body'],
      ),
    ).toThrow(/CHECK constraint failed/);

    // hunks.kind enum settled in T1.4 (#9): add/del/mod only.
    expect(() =>
      db.run(
        `INSERT INTO hunks (id, revision_id, pull_id, file_path, start_line, end_line, content, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['h-bad', revId, pullId, 'src/a.ts', 1, 1, '+x;', 'bogus'],
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('writes timestamps in ISO 8601 form with T separator and Z suffix', () => {
    applyMigrations(db, defaultMigrationsDir());
    db.run('INSERT INTO pulls (branch, base) VALUES (?, ?)', ['feat/ts', 'main']);
    const row = db.query<{ created_at: string }, []>('SELECT created_at FROM pulls').get()!;
    // strftime('%Y-%m-%dT%H:%M:%fZ', 'now') emits e.g. 2026-06-01T07:30:42.123Z
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects a duplicate (pull_id, number) revision', () => {
    applyMigrations(db, defaultMigrationsDir());
    const { pullId } = seedPullAndRevision(db, 'feat/y');
    expect(() =>
      db.run(
        'INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash) VALUES (?, ?, ?, ?, ?)',
        [pullId, 1, 'h2', 'b2', 'd2'],
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects a duplicate approval on the same (revision_id, chapter_id)', () => {
    applyMigrations(db, defaultMigrationsDir());
    const { pullId, revId } = seedPullAndRevision(db, 'feat/approve');

    const chapterId = Number(
      db.run(
        `INSERT INTO chapters (revision_id, pull_id, marker, title, "order") VALUES (?, ?, ?, ?, ?)`,
        [revId, pullId, '§ 01', 'Why', 1],
      ).lastInsertRowid,
    );

    db.run('INSERT INTO approvals (revision_id, pull_id, chapter_id) VALUES (?, ?, ?)', [
      revId,
      pullId,
      chapterId,
    ]);
    expect(() =>
      db.run('INSERT INTO approvals (revision_id, pull_id, chapter_id) VALUES (?, ?, ?)', [
        revId,
        pullId,
        chapterId,
      ]),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('applyMigrations against a synthetic migrations dir', () => {
  let db: Database;
  let dir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'reviewdev-mig-apply-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies new files added after the first run', () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER)');
    expect(applyMigrations(db, dir).map((m) => m.version)).toEqual([1]);

    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER)');
    expect(applyMigrations(db, dir).map((m) => m.version)).toEqual([2]);

    // tables() already returns name-sorted (ORDER BY name in the helper).
    expect(tables(db)).toEqual(['a', 'b', 'meta']);
  });

  it('rolls back a failing migration; meta row is not written', () => {
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER)');
    writeFileSync(join(dir, '002_broken.sql'), 'CREATE TABLE broken (x INTEGER); BOGUS SYNTAX;');

    expect(() => applyMigrations(db, dir)).toThrow();

    // 001 still applied, 002 fully rolled back.
    const recorded = db
      .query<{ version: number }, []>('SELECT version FROM meta ORDER BY version')
      .all();
    expect(recorded).toEqual([{ version: 1 }]);
    expect(tables(db)).toEqual(['meta', 'ok']);
  });

  it('records empty or comment-only migrations as no-ops without crashing', () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER)');
    writeFileSync(join(dir, '002_empty.sql'), '');
    writeFileSync(join(dir, '003_comment_only.sql'), '-- placeholder; squashed away\n');
    writeFileSync(join(dir, '004_d.sql'), 'CREATE TABLE d (x INTEGER)');

    // The no-op files are recorded in meta but create no tables, and the
    // run continues past them instead of aborting on db.exec('').
    expect(applyMigrations(db, dir).map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(tables(db)).toEqual(['a', 'd', 'meta']);

    // Idempotent: the no-ops are remembered, so a re-run applies nothing.
    expect(applyMigrations(db, dir)).toEqual([]);
  });

  it('throws when the migrations directory does not exist', () => {
    // A missing dir (e.g. a packaging bug in defaultMigrationsDir) must
    // surface an error, not silently report "nothing to apply".
    expect(() => applyMigrations(db, join(dir, 'does-not-exist'))).toThrow();
  });
});

describe('currentVersion', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is 0 before any migration runs', () => {
    db.exec('CREATE TABLE meta (version INTEGER PRIMARY KEY, filename TEXT, applied_at TEXT)');
    expect(currentVersion(db)).toBe(0);
  });

  it('reports the highest applied migration version', () => {
    applyMigrations(db, defaultMigrationsDir());
    expect(currentVersion(db)).toBe(1);
  });
});

describe('latestMigrationVersion', () => {
  it('returns the highest bundled migration version', () => {
    expect(latestMigrationVersion(defaultMigrationsDir())).toBe(1);
  });

  it('is 0 for a directory with no migrations', () => {
    const empty = mkdtempSync(join(tmpdir(), 'reviewdev-empty-mig-'));
    try {
      expect(latestMigrationVersion(empty)).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
