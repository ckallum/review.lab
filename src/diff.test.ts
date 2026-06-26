import { describe, it, expect } from 'vitest';
import { diffHash, hunkId, parseDiff } from './diff.ts';

// T1.4 ships proportionate coverage of the parser + hash. The exhaustive
// property/fixture suite (30+ hash cases, 10+ revision-diff cases) is T1.6.

describe('hunkId', () => {
  it('is deterministic and lowercase hex', () => {
    const id = hunkId('src/a.ts', '+x;');
    expect(id).toBe(hunkId('src/a.ts', '+x;'));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on file_path and content separately', () => {
    expect(hunkId('a.ts', '+x;')).not.toBe(hunkId('b.ts', '+x;'));
    expect(hunkId('a.ts', '+x;')).not.toBe(hunkId('a.ts', '+y;'));
  });

  it('is order-sensitive in content (line reorder changes the hash)', () => {
    expect(hunkId('a.ts', '+x;\n+y;')).not.toBe(hunkId('a.ts', '+y;\n+x;'));
  });

  it('does not collapse the path/content boundary', () => {
    // Without the "\n" separator, ("ab","c") and ("a","bc") would collide.
    expect(hunkId('ab', 'c')).not.toBe(hunkId('a', 'bc'));
  });
});

describe('diffHash', () => {
  const a = hunkId('a.ts', '+x;');
  const b = hunkId('b.ts', '+y;');

  it('is order-independent over the hunk-id set', () => {
    expect(diffHash([a, b])).toBe(diffHash([b, a]));
  });

  it('collapses duplicate ids (set semantics)', () => {
    expect(diffHash([a, a, b])).toBe(diffHash([a, b]));
  });

  it('changes when the set of hunks changes', () => {
    expect(diffHash([a])).not.toBe(diffHash([a, b]));
    expect(diffHash([a])).not.toBe(diffHash([b]));
  });

  it('hashes an empty set to a stable lowercase-hex value', () => {
    expect(diffHash([])).toMatch(/^[0-9a-f]{64}$/);
    expect(diffHash([])).toBe(diffHash([]));
  });
});

describe('parseDiff', () => {
  const diff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index 1111111..2222222 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
    ' const d = 4;',
    '@@ -10,2 +11,2 @@ function g() {',
    '-  return old;',
    '+  return neu;',
    ' }',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-line one',
    '-line two',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..4444444',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+alpha',
    '+beta',
    '',
  ].join('\n');

  const hunks = parseDiff(diff);

  it('parses every @@ section across files', () => {
    expect(hunks.map((h) => `${h.filePath}:${h.kind}`)).toEqual([
      'src/foo.ts:add',
      'src/foo.ts:mod',
      'old.txt:del',
      'new.txt:add',
    ]);
  });

  it('uses the new-file line range for add/mod hunks', () => {
    expect({ s: hunks[0]!.startLine, e: hunks[0]!.endLine }).toEqual({ s: 1, e: 4 });
    expect({ s: hunks[1]!.startLine, e: hunks[1]!.endLine }).toEqual({ s: 11, e: 12 });
  });

  it('falls back to the old-file range for a deletion (new count is 0)', () => {
    expect({ s: hunks[2]!.startLine, e: hunks[2]!.endLine }).toEqual({ s: 1, e: 2 });
  });

  it('keeps body lines with their markers and excludes the @@ header', () => {
    expect(hunks[0]!.content).toBe(' const a = 1;\n+const b = 2;\n const c = 3;\n const d = 4;');
    expect(hunks[0]!.content).not.toContain('@@');
  });

  it('sets the id to the content hash of the parsed body', () => {
    expect(hunks[0]!.id).toBe(hunkId('src/foo.ts', hunks[0]!.content));
  });

  it('hashes an unchanged block identically even when its line numbers shift', () => {
    const body = ['@@ -1,2 +1,3 @@', ' keep;', '+added;', ' tail;'];
    const shifted = ['@@ -40,2 +51,3 @@', ' keep;', '+added;', ' tail;'];
    const head = ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts'];
    const a = parseDiff([...head, ...body, ''].join('\n'))[0]!;
    const b = parseDiff([...head, ...shifted, ''].join('\n'))[0]!;
    expect(a.id).toBe(b.id);
    expect(a.startLine).not.toBe(b.startLine); // numbers still tracked separately
  });

  it('handles a single-line hunk header with implicit count of 1', () => {
    const d = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -5 +5 @@', '-was', '+now', ''].join(
      '\n',
    );
    const h = parseDiff(d)[0]!;
    expect(h.kind).toBe('mod');
    expect({ s: h.startLine, e: h.endLine }).toEqual({ s: 5, e: 5 });
  });

  it('strips quoted paths and the a//b/ prefix', () => {
    const d = [
      'diff --git "a/sp ace.ts" "b/sp ace.ts"',
      '--- "a/sp ace.ts"',
      '+++ "b/sp ace.ts"',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
      '',
    ].join('\n');
    expect(parseDiff(d)[0]!.filePath).toBe('sp ace.ts');
  });

  it('keeps body lines that look like ---/+++ headers (content starting with --/++)', () => {
    // A removed line whose content is "-- a" renders as "--- a"; an added "++ b"
    // renders as "+++ b". These must be captured as the hunk body, not mistaken
    // for file-path headers (which only appear before the first @@).
    const d = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,2 +1,2 @@',
      '--- a',
      '+++ b',
      '',
    ].join('\n');
    const parsed = parseDiff(d);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.filePath).toBe('doc.md');
    expect(parsed[0]!.kind).toBe('mod');
    expect(parsed[0]!.content).toBe('--- a\n+++ b');
  });

  it('skips a degenerate hunk with no +/- lines', () => {
    const d = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      ' more',
      '',
    ].join('\n');
    expect(parseDiff(d)).toEqual([]);
  });

  it('returns no hunks for an empty diff or a binary/rename-only diff', () => {
    expect(parseDiff('')).toEqual([]);
    const binary = [
      'diff --git a/img.png b/img.png',
      'index 1..2 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    expect(parseDiff(binary)).toEqual([]);
  });
});
