import { createHash } from 'node:crypto';

/**
 * Unified-diff parsing + content hashing for `reviewdev publish` (T1.4).
 *
 * A "hunk" here is one `@@ … @@` section of `git diff` output. Each hunk is
 * addressed by a content hash that powers two things downstream (design.md
 * § Hunk identity): revision diffing (same hash in N and N-1 ⇒ unchanged) and
 * the chapter-inheritance hint. This module is pure — it takes raw diff text
 * and returns parsed hunks; all git I/O lives in `git.ts`.
 */

/**
 * Structural classification of a hunk, settled here as the first writer of
 * `hunks.kind` (issue #9, matching git-diff convention + FR-P0.4's `del`):
 * - `add` — only added (`+`) lines
 * - `del` — only removed (`-`) lines (FR-P0.4: deleted-only hunks)
 * - `mod` — both added and removed lines
 */
export type HunkKind = 'add' | 'del' | 'mod';

// Fields are `readonly`: a ParsedHunk is a value object whose `id` must always
// equal `hunkId(filePath, content)`. Freezing the fields stops a downstream
// caller (e.g. T1.5 assembling a revision) from mutating one without the other
// and silently breaking revision diffing, which keys on that hash.
export interface ParsedHunk {
  /** `SHA-256(file_path + "\n" + content)`, hex. The `hunks.id` column. */
  readonly id: string;
  /** New path for adds/mods; the deleted path for deletions. No `a/`/`b/`. */
  readonly filePath: string;
  /** 1-based first line in the new file (old file for deletions). */
  readonly startLine: number;
  /** 1-based last line; equals startLine for a single-line / empty range. */
  readonly endLine: number;
  /**
   * The hunk body exactly as git emits it — every line keeps its leading
   * ` `/`+`/`-`/`\` marker — joined by `\n`, with the `@@` header EXCLUDED.
   * Excluding the header (which carries volatile line numbers) is what lets an
   * unchanged block that merely shifted position keep the same hash across
   * revisions; the line numbers live in startLine/endLine instead.
   */
  readonly content: string;
  readonly kind: HunkKind;
}

/** `SHA-256(filePath + "\n" + content)` as lowercase hex — the `hunks.id`. */
export function hunkId(filePath: string, content: string): string {
  return createHash('sha256').update(`${filePath}\n${content}`).digest('hex');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Normalise a path token from a `---`/`+++` line: `/dev/null` ⇒ null, strip
 * surrounding quotes (git quotes paths with special chars) and the `a/`/`b/`
 * diff prefix. A trailing tab (git appends one for paths with spaces) is dropped.
 */
function diffPath(token: string): string | null {
  let p = token.replace(/\t.*$/, '').trim();
  if (p === '/dev/null') return null;
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/**
 * Parse `git diff` output into hunks. Binary diffs and pure renames/mode
 * changes carry no `@@` section and so contribute no hunks — correct, since
 * there is no textual content to hash.
 */
export function parseDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  // Split on \n; a trailing newline yields a final '' which the loop ignores
  // (it is neither a header nor a body line under an open hunk).
  const lines = diff.split('\n');

  // Path state for the file section currently being scanned.
  let oldPath: string | null = null;
  let newPath: string | null = null;

  // The hunk currently being accumulated, flushed on the next boundary.
  // `inHunk` gates whether subsequent lines are body or file-header content.
  let inHunk = false;
  let body: string[] = [];
  let filePath = '';
  let startLine = 0;
  let endLine = 0;

  const flush = () => {
    if (!inHunk) return;
    const content = body.join('\n');
    let hasAdd = false;
    let hasDel = false;
    for (const line of body) {
      if (line.startsWith('+')) hasAdd = true;
      else if (line.startsWith('-')) hasDel = true;
    }
    inHunk = false;
    body = [];
    // Skip a hunk with no +/- lines (pure context) — it records no change and
    // can't be classified. Real `git diff` never emits one; this keeps a
    // malformed input from producing a meaningless 'mod' row.
    if (!hasAdd && !hasDel) return;
    let kind: HunkKind = 'mod';
    if (hasAdd && !hasDel) kind = 'add';
    else if (hasDel && !hasAdd) kind = 'del';
    hunks.push({ id: hunkId(filePath, content), filePath, startLine, endLine, content, kind });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      oldPath = null;
      newPath = null;
      continue;
    }

    // `@@` and `diff --git` are the only boundaries detectable mid-hunk: a body
    // line can't match either (it always carries a leading ` `/`+`/`-`). The
    // `---`/`+++` path markers are NOT safe mid-hunk — a removed line whose
    // content starts with `-- ` renders as `--- …` — so they're read only in
    // the header section (when !inHunk), below.
    const m = line.match(HUNK_HEADER);
    if (m) {
      flush();
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      // New-file range addresses adds/mods; a deletion (newCount 0) has no new
      // lines, so fall back to the old-file range (FR-P0.4). endLine never
      // precedes startLine even for a zero-count range.
      startLine = newCount > 0 ? newStart : oldStart;
      const span = newCount > 0 ? newCount : oldCount;
      endLine = Math.max(startLine, startLine + span - 1);
      inHunk = true;
      // newPath is /dev/null for a deletion; oldPath carries the real path.
      filePath = newPath ?? oldPath ?? '';
      continue;
    }

    if (inHunk) {
      // Inside a hunk: every line is body until the next @@ / diff --git.
      // Context (' '), add ('+'), remove ('-'), and the "\ No newline" marker
      // are kept; a stray non-prefixed line (malformed input) is dropped.
      if (/^[ +\-\\]/.test(line)) body.push(line);
      continue;
    }

    // Header section (between `diff --git` and the first `@@`): pick up the
    // file's paths. `index`/mode/`Binary`/rename lines simply match nothing.
    if (line.startsWith('--- ')) oldPath = diffPath(line.slice(4));
    else if (line.startsWith('+++ ')) newPath = diffPath(line.slice(4));
  }
  flush();
  return hunks;
}
