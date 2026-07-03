import { describe, it, expect } from 'vitest';
import { diffHash, diffRevisions, hunkId, parseDiff, type ParsedHunk } from './diff.ts';

// T1.6 — the exhaustive hash + revision-diff suite. This is the NFR-6
// "silently-corruptible surface" coverage: the content-hash and the revision
// diff both fail silently (wrong dedup, wrong "unchanged" badge) rather than
// crashing, so they earn property + fixture tests here. `diff.test.ts` keeps
// the T1.4 proportionate parser coverage; this file owns hash + revision diff.

// ---------------------------------------------------------------------------
// Hash function — property cases on hunkId(file_path, content)
// ---------------------------------------------------------------------------
describe('hunkId — content-hash properties', () => {
  // A spread of (file_path, content) pairs: ascii, unicode, empty, whitespace,
  // markers, CRLF, quotes, tabs, long. Every one must hash to stable 64-hex,
  // and (asserted below) no two collide.
  const inputs: ReadonlyArray<readonly [string, string]> = [
    ['a.ts', '+x'],
    ['src/a.ts', ' const a = 1;\n+const b = 2;'],
    ['dir/sub/файл.ts', '+ю'],
    ['a b.ts', '+has space'],
    ['a.ts', ''],
    ['', '+empty path'],
    ['a.ts', ' \n \n '],
    ['weird".ts', '+quote'],
    ['emoji.ts', '+🎉'],
    ['a.ts', '-removed\n+added'],
    ['package-lock.json', '+  "x": 1'],
    ['a.ts', '\\ No newline at end of file'],
    ['deeply/nested/path/to/file.tsx', '+jsx'],
    ['CAPS.TS', '+X'],
    ['a.ts', 'plain context line'],
    ['a.ts', '+タブ\there'],
    ['x', 'y'],
    ['ab', 'c'],
    ['a', 'bc'],
    ['a.ts', `+${'x'.repeat(5000)}`],
    ['a.ts', '+líne'],
    ['a.ts', '+line\r\n+crlf'],
    ['a.ts', '+x\n+y'],
    ['a.ts', '+y\n+x'],
  ];

  it.each(inputs)('hashes (%j, %j) to a stable lowercase 64-hex digest', (fp, content) => {
    const id = hunkId(fp, content);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(hunkId(fp, content)); // deterministic
  });

  it('assigns a distinct hash to every distinct input in the table (no collisions)', () => {
    const ids = inputs.map(([fp, c]) => hunkId(fp, c));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is injective across 50 systematic content variations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(hunkId('a.ts', `+line ${i}`));
    expect(ids.size).toBe(50);
  });

  it('is injective across 50 systematic path variations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(hunkId(`file${i}.ts`, '+same body'));
    expect(ids.size).toBe(50);
  });

  it('depends on file_path (same content, different path → different hash)', () => {
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('b.ts', '+x'));
  });

  it('depends on content (same path, different content → different hash)', () => {
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('a.ts', '+y'));
  });

  it('does not collapse the path/content boundary (the \\n separator)', () => {
    // Without the separator, ("ab","c") and ("a","bc") would both hash "abc".
    expect(hunkId('ab', 'c')).not.toBe(hunkId('a', 'bc'));
  });

  it('is order-sensitive within content (reordered lines → different hash)', () => {
    expect(hunkId('a.ts', '+x\n+y')).not.toBe(hunkId('a.ts', '+y\n+x'));
  });

  it('is whitespace-sensitive (trailing space, leading space, trailing newline)', () => {
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('a.ts', '+x '));
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('a.ts', '+ x'));
    expect(hunkId('a.ts', '+a\n+b')).not.toBe(hunkId('a.ts', '+a\n+b\n'));
  });

  it('is case-sensitive in both path and content', () => {
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('A.ts', '+x'));
    expect(hunkId('a.ts', '+x')).not.toBe(hunkId('a.ts', '+X'));
  });

  it('hashes unicode content stably and distinguishes look-alikes', () => {
    expect(hunkId('a.ts', '+café')).toBe(hunkId('a.ts', '+café'));
    expect(hunkId('a.ts', '+café')).not.toBe(hunkId('a.ts', '+cafe'));
  });

  it('distinguishes empty content from a single space', () => {
    expect(hunkId('a.ts', '')).not.toBe(hunkId('a.ts', ' '));
  });

  // Known-answer regression guard: pins the EXACT construction
  // sha256(file_path + "\n" + content). A change to the order, separator, or
  // algorithm breaks this even though every relative property above still holds.
  it('pins the exact construction sha256(file_path + "\\n" + content)', () => {
    expect(hunkId('a.ts', '+x')).toBe(
      '4c261d57aa698faf156a536e168e7c06b5d76a40390bc690b54e1911c4ce5fba',
    );
    // ('', '') hashes the bare separator sha256('\n') — NOT sha256('') (which is
    // what diffHash([]) pins below); the separator is always present.
    expect(hunkId('', '')).toBe('01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b');
  });
});

// ---------------------------------------------------------------------------
// diff_hash — sorted-set properties on diffHash(ids)
// ---------------------------------------------------------------------------
describe('diffHash — sorted-set properties', () => {
  const A = hunkId('a.ts', '+a');
  const B = hunkId('b.ts', '+b');
  const C = hunkId('c.ts', '+c');

  it('is order-independent over all permutations of the id set', () => {
    const perms = [
      [A, B, C],
      [A, C, B],
      [B, A, C],
      [B, C, A],
      [C, A, B],
      [C, B, A],
    ];
    const hashes = new Set(perms.map((p) => diffHash(p)));
    expect(hashes.size).toBe(1);
  });

  it('collapses duplicates (set semantics)', () => {
    expect(diffHash([A, A, B, B])).toBe(diffHash([A, B]));
    expect(diffHash([A, B, A])).toBe(diffHash([B, A]));
  });

  it('changes when the set of ids changes', () => {
    expect(diffHash([A, B])).not.toBe(diffHash([A, C]));
    expect(diffHash([A])).not.toBe(diffHash([A, B]));
  });

  it('pins the empty set to sha256("") and the two-id construction [known-answer]', () => {
    expect(diffHash([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(diffHash([hunkId('a.ts', '+x'), hunkId('b.ts', '+y')])).toBe(
      '3d46239c703f24d275dedddc9da256b8a6a3193ffc10117eca73618e09f5d09d',
    );
  });
});

// ---------------------------------------------------------------------------
// Revision diffing — fixture cases over diffRevisions(prev, next)
// ---------------------------------------------------------------------------
describe('diffRevisions — revision code delta', () => {
  // Build a single-file section of `git diff` output (header + hunk lines).
  // Emits `+++ b/<path>` on both sides even for deletion hunks (`@@ -N +0,0 @@`)
  // where real git writes `+++ /dev/null`; parseDiff resolves `filePath` to the
  // same value either way (`newPath ?? oldPath`), so the hunk id is identical.
  const fileDiff = (path: string, ...hunkLines: string[]): string[] => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunkLines,
  ];
  const parse = (lines: string[]): ParsedHunk[] => parseDiff(lines.join('\n'));
  const sortedIds = (hs: readonly ParsedHunk[]): string[] => hs.map((h) => h.id).sort();
  const paths = (hs: readonly ParsedHunk[]): string[] => hs.map((h) => h.filePath).sort();

  it('identical revisions → everything unchanged, nothing added/removed', () => {
    const rev = parse(fileDiff('a.ts', '@@ -1,2 +1,3 @@', ' keep', '+add', ' tail'));
    const d = diffRevisions(rev, rev);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(sortedIds(d.unchanged)).toEqual(sortedIds(rev));
  });

  it('a hunk present only in N is added; shared hunks stay unchanged', () => {
    const shared = fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+b');
    const prev = parse(shared);
    const next = parse([...shared, ...fileDiff('new.ts', '@@ -0,0 +1 @@', '+brand new')]);
    const d = diffRevisions(prev, next);
    expect(paths(d.added)).toEqual(['new.ts']);
    expect(d.removed).toEqual([]);
    expect(sortedIds(d.unchanged)).toEqual(sortedIds(prev));
  });

  it('a hunk present only in N-1 is removed', () => {
    const shared = fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+b');
    const prev = parse([...shared, ...fileDiff('old.ts', '@@ -1 +0,0 @@', '-gone')]);
    const next = parse(shared);
    const d = diffRevisions(prev, next);
    expect(paths(d.removed)).toEqual(['old.ts']);
    expect(d.added).toEqual([]);
    expect(sortedIds(d.unchanged)).toEqual(sortedIds(next));
  });

  it('a file rename surfaces as remove(old) + add(new) under content-addressing', () => {
    const prev = parse(fileDiff('old.ts', '@@ -1 +1,2 @@', ' x', '+y'));
    const next = parse(fileDiff('new.ts', '@@ -1 +1,2 @@', ' x', '+y')); // same body, new path
    const d = diffRevisions(prev, next);
    expect(paths(d.removed)).toEqual(['old.ts']);
    expect(paths(d.added)).toEqual(['new.ts']);
    expect(d.unchanged).toEqual([]);
  });

  it('reordered hunks with identical content are all unchanged (order-independent)', () => {
    const fa = fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+aa');
    const fb = fileDiff('b.ts', '@@ -1 +1,2 @@', ' b', '+bb');
    const prev = parse([...fa, ...fb]);
    const next = parse([...fb, ...fa]); // reversed order in the diff
    const d = diffRevisions(prev, next);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(sortedIds(d.unchanged)).toEqual(sortedIds(prev));
  });

  it('a whitespace edit re-hashes the hunk: old removed, new added', () => {
    const prev = parse(fileDiff('a.ts', '@@ -1,2 +1,2 @@', ' keep', '+val'));
    const next = parse(fileDiff('a.ts', '@@ -1,2 +1,2 @@', ' keep', '+val ')); // trailing space
    const d = diffRevisions(prev, next);
    expect(d.unchanged).toEqual([]);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it('a line inserted mid-hunk re-hashes that hunk', () => {
    const prev = parse(fileDiff('a.ts', '@@ -1,3 +1,4 @@', ' a', '+b', ' c', ' d'));
    const next = parse(fileDiff('a.ts', '@@ -1,3 +1,5 @@', ' a', '+b', '+INSERTED', ' c', ' d'));
    const d = diffRevisions(prev, next);
    expect(d.unchanged).toEqual([]);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it('a hunk that only shifts position (same body) stays unchanged — line numbers excluded', () => {
    const prev = parse(fileDiff('a.ts', '@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'));
    const next = parse(fileDiff('a.ts', '@@ -40,2 +51,3 @@', ' keep', '+added', ' tail'));
    const d = diffRevisions(prev, next);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(sortedIds(d.unchanged)).toEqual(sortedIds(prev));
    // The surviving hunk is sourced from N, so it carries N's line numbers (the
    // view shows current position). Assert the value, not just that N != N-1 —
    // otherwise sourcing `unchanged` from `prev` would slip through.
    expect(prev[0]!.startLine).not.toBe(next[0]!.startLine);
    expect(d.unchanged[0]!.startLine).toBe(next[0]!.startLine);
  });

  it('against an empty prior (n=1), every hunk is added', () => {
    const next = parse(fileDiff('a.ts', '@@ -0,0 +1,2 @@', '+x', '+y'));
    const d = diffRevisions([], next);
    expect(sortedIds(d.added)).toEqual(sortedIds(next));
    expect(d.removed).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  it('against an empty next, every prior hunk is removed', () => {
    const prev = parse(fileDiff('a.ts', '@@ -1,2 +0,0 @@', '-x', '-y'));
    const d = diffRevisions(prev, []);
    expect(sortedIds(d.removed)).toEqual(sortedIds(prev));
    expect(d.added).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  it('two empty revisions → all three buckets empty', () => {
    expect(diffRevisions([], [])).toEqual({ added: [], removed: [], unchanged: [] });
  });

  it('is total over duplicate ids — a repeated hunk collapses, no double-count', () => {
    // Freshly-parsed hunks aren't deduped (the DB write path is); a caller that
    // diffs them directly must not double-count a repeated id.
    const one = parse(fileDiff('a.ts', '@@ -1 +1,2 @@', ' x', '+y'));
    expect(one).toHaveLength(1);
    const d = diffRevisions([...one, ...one], [...one, ...one]);
    expect(d.unchanged).toHaveLength(1);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('classifies a mixed revision: some unchanged, some removed, some added', () => {
    const keep = fileDiff('keep.ts', '@@ -1 +1,2 @@', ' k', '+kk');
    const gone = fileDiff('gone.ts', '@@ -1 +0,0 @@', '-g');
    const fresh = fileDiff('fresh.ts', '@@ -0,0 +1 @@', '+f');
    const prev = parse([...keep, ...gone]);
    const next = parse([...keep, ...fresh]);
    const d = diffRevisions(prev, next);
    expect(paths(d.unchanged)).toEqual(['keep.ts']);
    expect(paths(d.removed)).toEqual(['gone.ts']);
    expect(paths(d.added)).toEqual(['fresh.ts']);
  });

  it('identical content in different files hashes distinctly (path is part of identity)', () => {
    const both = [
      ...fileDiff('a.ts', '@@ -1 +1,2 @@', ' x', '+y'),
      ...fileDiff('b.ts', '@@ -1 +1,2 @@', ' x', '+y'),
    ];
    const prev = parse(both);
    const next = parse(fileDiff('a.ts', '@@ -1 +1,2 @@', ' x', '+y')); // drops b.ts's copy
    expect(new Set(prev.map((h) => h.id)).size).toBe(2); // distinct despite identical body
    const d = diffRevisions(prev, next);
    expect(paths(d.removed)).toEqual(['b.ts']);
    expect(paths(d.unchanged)).toEqual(['a.ts']);
    expect(d.added).toEqual([]);
  });

  // Cross-check: diffRevisions and diffHash must agree on "did anything change".
  // Equal diff_hash ⇔ nothing added and nothing removed. If these ever diverge,
  // dedup (diffHash) and the diff view (diffRevisions) would disagree.
  it('agrees with diffHash — equal diff_hash iff nothing added or removed', () => {
    const base = parse([
      ...fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+aa'),
      ...fileDiff('b.ts', '@@ -1 +1,2 @@', ' b', '+bb'),
    ]);
    const reordered = parse([
      ...fileDiff('b.ts', '@@ -1 +1,2 @@', ' b', '+bb'),
      ...fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+aa'),
    ]);
    const changed = parse([
      ...fileDiff('a.ts', '@@ -1 +1,2 @@', ' a', '+aa'),
      ...fileDiff('b.ts', '@@ -1 +1,2 @@', ' b', '+CHANGED'),
    ]);

    for (const [prev, next] of [
      [base, base],
      [base, reordered],
      [base, changed],
    ] as const) {
      const d = diffRevisions(prev, next);
      const noStructuralChange = d.added.length === 0 && d.removed.length === 0;
      const sameHash = diffHash(prev.map((h) => h.id)) === diffHash(next.map((h) => h.id));
      expect(noStructuralChange).toBe(sameHash);
    }
  });
});
