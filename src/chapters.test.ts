import { describe, it, expect } from 'vitest';
import type { Database } from 'bun:sqlite';
import { hunkId, type ParsedHunk } from './diff.ts';
import { applyMigrations, defaultMigrationsDir, openDb } from './db/migrate.ts';
import { createRevision } from './db/revisions.ts';
import { fileBasedChapters, insertChapters, MAX_CHAPTERS, type FileChapter } from './chapters.ts';

// A ParsedHunk with a content-hash id derived the same way publish derives it,
// so ids are distinct per (path, startLine) and stable across calls — a repeated
// mk(path, n) reproduces the same id (needed for the dedupe case).
function mk(filePath: string, startLine = 1, endLine = startLine): ParsedHunk {
  const content = `+${filePath}#${startLine}`;
  return { id: hunkId(filePath, content), filePath, startLine, endLine, content, kind: 'add' };
}

// The rendered layout of a chapter set: marker/title/summary plus the file paths
// its hunk ids resolve to, in emitted order.
function layout(hunks: ParsedHunk[]) {
  const chs = fileBasedChapters(hunks);
  const byId = new Map(hunks.map((h) => [h.id, h.filePath]));
  return chs.map((c) => ({
    marker: c.marker,
    title: c.title,
    summary: c.summary,
    order: c.order,
    files: c.hunkIds.map((id) => byId.get(id)!),
  }));
}

const titles = (hunks: ParsedHunk[]) => fileBasedChapters(hunks).map((c) => c.title);
const markers = (hunks: ParsedHunk[]) => fileBasedChapters(hunks).map((c) => c.marker);

// ---------------------------------------------------------------------------
// Grouping — the design-panel test matrix (24 vectors).
// ---------------------------------------------------------------------------
describe('fileBasedChapters — grouping', () => {
  it('empty_input → no chapters', () => {
    expect(fileBasedChapters([])).toEqual([]);
  });

  it('single_file_floor → 1 chapter (cannot fabricate 3)', () => {
    expect(layout([mk('src/a.ts')])).toEqual([
      { marker: '§ 01', title: 'src · .ts', summary: null, order: 1, files: ['src/a.ts'] },
    ]);
  });

  it('two_files_same_dir_ext → 1 chapter (no per-file split)', () => {
    const l = layout([mk('src/a.ts'), mk('src/b.ts')]);
    expect(l).toHaveLength(1);
    expect(l[0].title).toBe('src · .ts');
    expect(l[0].files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('two_ext_one_dir → 2 chapters, ext asc (css < ts)', () => {
    expect(titles([mk('src/a.ts'), mk('src/a.css')])).toEqual(['src · .css', 'src · .ts']);
  });

  it('two_single_ext_dirs_floor → 2 chapters, dir asc (lib < src)', () => {
    expect(titles([mk('src/a.ts'), mk('lib/b.ts')])).toEqual(['lib · .ts', 'src · .ts']);
  });

  it('three_dirs → DIR granularity, no ext split', () => {
    expect(titles([mk('src/a.ts'), mk('lib/b.ts'), mk('docs/c.md')])).toEqual([
      'docs',
      'lib',
      'src',
    ]);
  });

  it('target_reached_via_ext → 3 chapters from one dir', () => {
    expect(titles([mk('src/a.ts'), mk('src/b.js'), mk('src/c.css')])).toEqual([
      'src · .css',
      'src · .js',
      'src · .ts',
    ]);
  });

  it('two_dirs_ext_split_to_four', () => {
    expect(titles([mk('src/a.ts'), mk('src/b.js'), mk('src/c.css'), mk('lib/d.ts')])).toEqual([
      'lib · .ts',
      'src · .css',
      'src · .js',
      'src · .ts',
    ]);
  });

  it('root_and_dir_mix → named dir before root; within root "" < md', () => {
    const l = layout([mk('README.md'), mk('LICENSE'), mk('src/a.ts'), mk('src/b.ts')]);
    expect(l.map((c) => c.title)).toEqual(['src · .ts', '(root) · (no ext)', '(root) · .md']);
    expect(l[0].files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(l[1].files).toEqual(['LICENSE']);
    expect(l[2].files).toEqual(['README.md']);
  });

  it('dotfiles_collapse_to_noext', () => {
    const l = layout([mk('.gitignore'), mk('.env'), mk('src/a.ts')]);
    expect(l.map((c) => c.title)).toEqual(['src · .ts', '(root) · (no ext)']);
    expect(l[1].files).toEqual(['.env', '.gitignore']); // within-chapter filePath asc
  });

  it('root_only_three_ext → "" < json < md', () => {
    expect(titles([mk('README.md'), mk('package.json'), mk('LICENSE')])).toEqual([
      '(root) · (no ext)',
      '(root) · .json',
      '(root) · .md',
    ]);
  });

  it('compound_ext_last_dot (foo.test.ts → ts, archive.tar.gz → gz)', () => {
    expect(titles([mk('src/foo.test.ts'), mk('src/archive.tar.gz')])).toEqual([
      'src · .gz',
      'src · .ts',
    ]);
  });

  it('ext_case_folds (.TS and .ts merge)', () => {
    const l = layout([mk('src/a.TS'), mk('src/b.ts')]);
    expect(l).toHaveLength(1);
    expect(l[0].title).toBe('src · .ts');
    expect(l[0].files).toEqual(['src/a.TS', 'src/b.ts']);
  });

  it('dir_case_sensitive (Src ≠ src, "S"(83) < "s"(115))', () => {
    expect(titles([mk('Src/a.ts'), mk('src/b.ts')])).toEqual(['Src · .ts', 'src · .ts']);
  });

  it('multidot_dotfile (.env.local → local)', () => {
    expect(titles([mk('.env.local')])).toEqual(['(root) · .local']);
  });

  it('exactly_seven_dirs → no cap', () => {
    const hunks = Array.from({ length: 7 }, (_, i) => mk(`d${i + 1}/f.ts`));
    expect(markers(hunks)).toEqual(['§ 01', '§ 02', '§ 03', '§ 04', '§ 05', '§ 06', '§ 07']);
    expect(titles(hunks)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  });

  it('eight_dirs → cap to 7, smallest tail folds into (other)', () => {
    const hunks = Array.from({ length: 8 }, (_, i) => mk(`d${i + 1}/f.ts`));
    const l = layout(hunks);
    expect(l).toHaveLength(7);
    expect(l.map((c) => c.title)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', '(other)']);
    expect(l[6].files.sort()).toEqual(['d7/f.ts', 'd8/f.ts']);
  });

  it('twenty_dirs → cap to 7, (other) unions the tail', () => {
    // Zero-padded so string order matches numeric order for a readable assertion.
    const hunks = Array.from({ length: 20 }, (_, i) =>
      mk(`d${String(i + 1).padStart(2, '0')}/f.ts`),
    );
    const l = layout(hunks);
    expect(l).toHaveLength(7);
    expect(l.slice(0, 6).map((c) => c.title)).toEqual(['d01', 'd02', 'd03', 'd04', 'd05', 'd06']);
    expect(l[6].title).toBe('(other)');
    expect(l[6].files).toHaveLength(14); // d07..d20
  });

  it('one_dir_ten_ext → cap to 7', () => {
    const exts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const l = layout(exts.map((e) => mk(`src/f.${e}`)));
    expect(l).toHaveLength(7);
    expect(l[6].title).toBe('(other)');
    expect(l[6].files).toHaveLength(4); // 10 exts − 6 kept
  });

  it('split_then_overshoot_then_merge (coverage intact after cap)', () => {
    const hunks = [
      mk('src/a.ts'),
      mk('src/b.js'),
      mk('src/c.css'),
      mk('src/d.html'),
      mk('src/e.json'),
      mk('src/f.md'),
      mk('src/g.py'),
      mk('src/h.rb'),
      mk('web/x.ts'),
    ];
    const chs = fileBasedChapters(hunks);
    expect(chs).toHaveLength(7);
    expect(chs[6].title).toBe('(other)');
    // Every input hunk still appears exactly once across all chapters.
    const all = chs.flatMap((c) => c.hunkIds);
    expect(new Set(all)).toEqual(new Set(hunks.map((h) => h.id)));
    expect(all).toHaveLength(hunks.length);
  });

  it('size_aware_cap keeps the big directory out of overflow', () => {
    const big = Array.from({ length: 20 }, (_, i) => mk('src/f.ts', i + 1));
    const small = Array.from({ length: 8 }, (_, i) => mk(`d${i + 1}/f.ts`));
    const chs = fileBasedChapters([...big, ...small]);
    expect(chs).toHaveLength(7);
    const src = chs.find((c) => c.title === 'src');
    expect(src).toBeDefined();
    expect(src!.hunkIds).toHaveLength(20); // all of src survives standalone
    expect(chs.some((c) => c.title === '(other)')).toBe(true);
  });

  it('within_chapter_position_order (startLine asc)', () => {
    const h50 = mk('src/a.ts', 50);
    const h10 = mk('src/a.ts', 10);
    const chs = fileBasedChapters([h50, h10]);
    expect(chs).toHaveLength(1);
    expect(chs[0].hunkIds).toEqual([h10.id, h50.id]);
  });

  it('defensive_dedupe (same id twice → one hunk)', () => {
    const h = mk('src/a.ts');
    const chs = fileBasedChapters([h, h]);
    expect(chs).toHaveLength(1);
    expect(chs[0].hunkIds).toEqual([h.id]);
  });

  it('determinism_shuffle (order-independent)', () => {
    const hs = [mk('src/a.ts'), mk('lib/b.ts'), mk('docs/c.md')];
    const base = fileBasedChapters(hs);
    expect(fileBasedChapters([hs[2], hs[0], hs[1]])).toEqual(base);
    expect(titles([hs[2], hs[0], hs[1]])).toEqual(['docs', 'lib', 'src']);
  });

  it('trailing_dot_no_ext (foo. → no ext)', () => {
    expect(titles([mk('src/foo.')])).toEqual(['src · (no ext)']);
  });

  it('leading_slash_routes_to_root (defensive; diff.ts never emits it)', () => {
    expect(titles([mk('/x')])).toEqual(['(root) · (no ext)']);
  });

  it('duplicate ids at different line ranges → canonical survivor, order-independent', () => {
    // id excludes line numbers (diff.ts hunkId), so byte-identical content in one
    // file shares an id but can sit at two positions. mk() can't build this (it
    // folds startLine into content), so hand-build the pair around a third hunk
    // whose position sits between them — the case that broke last-write-wins.
    const id = hunkId('src/x.ts', '+DUP');
    const early = {
      id,
      filePath: 'src/x.ts',
      startLine: 5,
      endLine: 5,
      content: '+DUP',
      kind: 'add',
    } as const;
    const late = {
      id,
      filePath: 'src/x.ts',
      startLine: 50,
      endLine: 50,
      content: '+DUP',
      kind: 'add',
    } as const;
    const mid = mk('src/x.ts', 20); // distinct id, startLine between the two positions

    const forward = fileBasedChapters([early, mid, late]);
    const reverse = fileBasedChapters([late, mid, early]);
    expect(reverse).toEqual(forward); // byte-for-byte, regardless of input order
    expect(forward).toHaveLength(1);
    // Canonical survivor is the earliest occurrence (line 5) → sorts before
    // mid@20; last-write-wins would have let input order flip this.
    expect(forward[0].hunkIds).toEqual([id, mid.id]);
  });
});

// ---------------------------------------------------------------------------
// Invariants — hold across every shape (mirrors the chunk-merge invariant).
// ---------------------------------------------------------------------------
describe('fileBasedChapters — invariants', () => {
  const shapes: readonly ParsedHunk[][] = [
    [],
    [mk('a.ts')],
    [mk('src/a.ts'), mk('src/b.ts')],
    [mk('src/a.ts'), mk('lib/b.ts'), mk('docs/c.md')],
    ['README.md', 'LICENSE', 'src/a.ts', 'src/b.js', 'lib/c.ts', 'lib/d.css'].map((p) => mk(p)),
    Array.from({ length: 8 }, (_, i) => mk(`d${i + 1}/f.ts`)),
    Array.from({ length: 20 }, (_, i) => mk(`d${String(i + 1).padStart(2, '0')}/f.ts`)),
    Array.from({ length: 12 }, (_, i) => mk(`src/f.${String.fromCharCode(97 + i)}`)),
    Array.from({ length: 30 }, (_, i) => mk(`pkg${i % 5}/sub/f${i}.ts`, i + 1)),
  ];

  for (let s = 0; s < shapes.length; s++) {
    const hunks = shapes[s];
    const ids = new Set(hunks.map((h) => h.id));

    it(`shape ${s}: every hunk in exactly one chapter (total coverage)`, () => {
      const chs = fileBasedChapters(hunks);
      const all = chs.flatMap((c) => c.hunkIds);
      expect(all).toHaveLength(ids.size); // no duplication
      expect(new Set(all)).toEqual(ids); // no omission
    });

    it(`shape ${s}: count in [0, ${MAX_CHAPTERS}], 0 iff empty`, () => {
      const chs = fileBasedChapters(hunks);
      expect(chs.length).toBeLessThanOrEqual(MAX_CHAPTERS);
      expect(chs.length === 0).toBe(ids.size === 0);
      if (ids.size > 0) expect(chs.length).toBeGreaterThanOrEqual(1);
    });

    it(`shape ${s}: markers contiguous "§ NN" equal to order; every chapter non-empty`, () => {
      const chs = fileBasedChapters(hunks);
      chs.forEach((c, i) => {
        expect(c.order).toBe(i + 1);
        expect(c.marker).toBe(`§ ${String(i + 1).padStart(2, '0')}`);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.summary).toBeNull();
        expect(c.hunkIds.length).toBeGreaterThan(0);
      });
    });

    it(`shape ${s}: order-independent (shuffle → identical output)`, () => {
      const base = fileBasedChapters(hunks);
      // Deterministic reversal + rotation, no Math.random.
      const shuffled = [...hunks].reverse();
      if (shuffled.length > 1) shuffled.push(shuffled.shift()!);
      expect(fileBasedChapters(shuffled)).toEqual(base);
    });
  }
});

// ---------------------------------------------------------------------------
// Persistence — insertChapters writes chapters + chapter_hunks.
// ---------------------------------------------------------------------------
function freshDb(): Database {
  const db = openDb(':memory:');
  applyMigrations(db, defaultMigrationsDir());
  return db;
}

describe('insertChapters', () => {
  it('writes chapters and their ordered hunk links', () => {
    const db = freshDb();
    db.run(`INSERT INTO pulls (branch, base) VALUES ('feature', 'main')`);
    db.run(
      `INSERT INTO revisions (pull_id, number, git_head_sha, git_base_sha, diff_hash)
       VALUES (1, 1, 'head', 'base', 'hash')`,
    );
    const chapters: FileChapter[] = [
      { marker: '§ 01', title: 'src · .ts', summary: null, order: 1, hunkIds: ['id-a', 'id-b'] },
      { marker: '§ 02', title: '(root) · .md', summary: null, order: 2, hunkIds: ['id-c'] },
    ];
    insertChapters(db, 1, 1, chapters);

    const rows = db
      .query<
        {
          marker: string;
          title: string;
          summary: string | null;
          order: number;
          pull_id: number;
          inherited_from_chapter_id: number | null;
        },
        []
      >(
        'SELECT marker, title, summary, "order", pull_id, inherited_from_chapter_id FROM chapters ORDER BY "order"',
      )
      .all();
    expect(rows).toEqual([
      {
        marker: '§ 01',
        title: 'src · .ts',
        summary: null,
        order: 1,
        pull_id: 1,
        inherited_from_chapter_id: null,
      },
      {
        marker: '§ 02',
        title: '(root) · .md',
        summary: null,
        order: 2,
        pull_id: 1,
        inherited_from_chapter_id: null,
      },
    ]);

    const links = db
      .query<{ hunk_id: string; order: number }, []>(
        `SELECT ch.hunk_id, ch."order" FROM chapter_hunks ch
         JOIN chapters c ON c.id = ch.chapter_id
         ORDER BY c."order", ch."order"`,
      )
      .all();
    expect(links).toEqual([
      { hunk_id: 'id-a', order: 1 },
      { hunk_id: 'id-b', order: 2 },
      { hunk_id: 'id-c', order: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wiring — createRevision persists file-based chapters for a new revision.
// ---------------------------------------------------------------------------
describe('createRevision → file-based chapters', () => {
  const input = (hunks: ParsedHunk[]) => ({
    branch: 'feature',
    base: 'main',
    headSha: 'head1',
    baseSha: 'base1',
    hunks,
  });

  it('writes chapters + chapter_hunks on a new revision', () => {
    const db = freshDb();
    const hunks = [mk('src/a.ts'), mk('lib/b.ts'), mk('docs/c.md')];
    createRevision(db, input(hunks));

    const chapters = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chapters').get()!.n;
    expect(chapters).toBe(3); // three dirs → three chapters
    const links = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chapter_hunks').get()!.n;
    expect(links).toBe(3);
    // Every persisted chapter belongs to the created revision.
    const orphan = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chapters WHERE revision_id != 1')
      .get()!.n;
    expect(orphan).toBe(0);
  });

  it('a duplicate re-publish adds no new chapters', () => {
    const db = freshDb();
    const hunks = [mk('src/a.ts'), mk('lib/b.ts'), mk('docs/c.md')];
    createRevision(db, input(hunks));
    createRevision(db, { ...input(hunks), headSha: 'head2' }); // same hunk set → dedup
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chapters').get()!.n).toBe(3);
  });
});
