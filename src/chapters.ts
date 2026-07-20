import type { Database } from 'bun:sqlite';
import { dedupeHunks, type ParsedHunk } from './diff.ts';

/**
 * File-based chapter fallback (T1.8) — the deterministic, no-LLM grouping that
 * turns a revision's hunks into an ordered chapter set. Used whenever chapter
 * generation has no `ANTHROPIC_API_KEY` to call (SPEC.md § LLM config); in week 1
 * it is the only chapter source, so `reviewdev publish` writes revisions with
 * file-based chapters (SPEC.md § Roadmap).
 *
 * The rules (SPEC.md § LLM config, tasks.md T1.8):
 * - Group hunks by TOP-LEVEL directory; SECONDARY split by file extension.
 * - Aim for 3–7 chapters with `§ NN` marker numbering.
 *
 * `fileBasedChapters` is pure and set-valued — identical hunk sets yield
 * byte-identical chapters regardless of input order (matching the set semantics
 * `diffHash`/`dedupeHunks` already commit to). `insertChapters` persists the
 * result; both run inside the `createRevision` transaction.
 */

/** A chapter as this module emits it, before it is written to `chapters` +
 * `chapter_hunks`. `hunkIds` is ordered; its index drives `chapter_hunks.order`. */
export interface FileChapter {
  readonly marker: string; // `§ NN`, zero-padded, equal to `order`
  readonly title: string; // non-empty label (dir, `dir · .ext`, `(root)`, `(other)`)
  readonly summary: string | null; // always null for the no-LLM path
  readonly order: number; // 1-based, contiguous
  readonly hunkIds: readonly string[];
}

/** Hard ceiling on chapters per revision. The 3-chapter target is best-effort
 * (a diff spanning < 3 groups can't reach it without fabricating empty
 * chapters); 7 is enforced unconditionally by merging the overflow. */
export const MAX_CHAPTERS = 7;

type Granularity = 'dir' | 'ext';

interface TopDir {
  readonly isRoot: boolean;
  readonly dir: string | null; // null when isRoot
}

interface Group {
  // The grouping key is set once at construction; only `hunks` accumulates.
  readonly isRoot: boolean;
  readonly dir: string | null;
  readonly ext: string | null; // null under 'dir' granularity; '' (no ext) or the ext under 'ext'
  readonly isOverflow: boolean; // the synthetic `(other)` merge bucket
  hunks: ParsedHunk[];
}

/** First path segment, or the root bucket for a bare filename. A defensive
 * leading `/` (never emitted by `diff.ts`, which strips `a/`/`b/`) also routes
 * to root rather than minting an empty-string directory. Dir keys are
 * byte-exact — `Src` and `src` are genuinely different directories in git. */
function topDir(path: string): TopDir {
  const i = path.indexOf('/');
  return i <= 0 ? { isRoot: true, dir: null } : { isRoot: false, dir: path.slice(0, i) };
}

/** Extension = the basename segment after its LAST dot, lowercased. `j <= 0`
 * collapses no-dot names (`Makefile`) and leading-dot dotfiles (`.gitignore`)
 * to `''`; a trailing dot (`foo.`) is `''` too. Compound extensions collapse
 * to the final segment (`bundle.tar.gz` → `gz`, `types.d.ts` → `ts`) — a
 * deliberate simplification; semantic grouping is the LLM path's job. */
function ext(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const j = base.lastIndexOf('.');
  return j <= 0 || j === base.length - 1 ? '' : base.slice(j + 1).toLowerCase();
}

// Group keys are JSON tuples so a directory or extension containing the field
// separator can never collide with a different bucket.
function dirKey(td: TopDir): string {
  return JSON.stringify([td.isRoot, td.dir]);
}
function extKey(td: TopDir, e: string): string {
  return JSON.stringify([td.isRoot, td.dir, e]);
}

function rankOf(g: Group): number {
  return g.isOverflow ? 2 : g.isRoot ? 1 : 0;
}
function sortDir(g: Group): string {
  return g.isRoot || g.isOverflow ? '' : (g.dir ?? '');
}
function sortExt(g: Group, granularity: Granularity): string {
  return granularity === 'ext' && !g.isOverflow ? (g.ext ?? '') : '';
}

/** Display order: named-dir chapters first (by directory), then root-file
 * chapters, then the single `(other)` overflow last. Within an extension split,
 * ties break by extension (`''` no-ext first). All comparisons use JS `<` on
 * UTF-16 code units — never `localeCompare`, whose locale-sensitivity would make
 * chapter order machine-dependent. Group keys are distinct by construction, so
 * this is a strict total order. */
function cmpDisplay(a: Group, b: Group, granularity: Granularity): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra - rb;
  const da = sortDir(a);
  const db = sortDir(b);
  if (da !== db) return da < db ? -1 : 1;
  const ea = sortExt(a, granularity);
  const eb = sortExt(b, granularity);
  if (ea !== eb) return ea < eb ? -1 : 1;
  return 0;
}

/** Hunk ids in stable within-chapter order: file path, then position, then the
 * content-hash id as a terminal tiebreak so two hunks sharing path+range still
 * order deterministically. */
function orderedHunkIds(hunks: readonly ParsedHunk[]): string[] {
  return [...hunks]
    .sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      if (a.endLine !== b.endLine) return a.endLine - b.endLine;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((h) => h.id);
}

function titleFor(g: Group, granularity: Granularity): string {
  if (g.isOverflow) return '(other)';
  const dirLabel = g.isRoot ? '(root)' : (g.dir as string);
  if (granularity === 'dir') return dirLabel;
  const extLabel = g.ext ? `.${g.ext}` : '(no ext)';
  return `${dirLabel} · ${extLabel}`;
}

/**
 * Merge a too-large group list down to exactly `MAX_CHAPTERS`. Keeps the 6
 * largest groups standalone (by hunk count, so a big directory is never buried)
 * and folds the smaller tail into one `(other)` bucket. Only called when the
 * list exceeds `MAX_CHAPTERS`, so the folded tail always holds ≥ 2 groups and
 * the overflow is never empty.
 */
function capGroups(groups: Group[], granularity: Granularity): Group[] {
  const ranked = [...groups].sort((a, b) => {
    if (a.hunks.length !== b.hunks.length) return b.hunks.length - a.hunks.length; // count desc
    return cmpDisplay(a, b, granularity); // stable, deterministic tiebreak
  });
  const keep = ranked.slice(0, MAX_CHAPTERS - 1);
  const tail = ranked.slice(MAX_CHAPTERS - 1);
  const overflow: Group = {
    isRoot: false,
    dir: null,
    ext: null,
    isOverflow: true,
    hunks: tail.flatMap((g) => g.hunks),
  };
  return [...keep, overflow];
}

/**
 * Group a revision's hunks into an ordered file-based chapter set.
 *
 * - Dedupes by content-hash id (set semantics) so the output is a pure function
 *   of the hunk set and `chapter_hunks (chapter_id, hunk_id)` can't collide.
 * - Groups by top-level directory. With ≥ 3 directories that is the chapter
 *   granularity. With 1–2 directories it refines by extension to reach the
 *   3-chapter target; a diff spanning fewer than 3 (dir, ext) cells honestly
 *   yields fewer than 3 chapters rather than inventing empty ones.
 * - Caps at `MAX_CHAPTERS` by merging the smallest groups into `(other)`.
 *
 * Guarantees (asserted in chapters.test.ts): every hunk lands in exactly one
 * chapter; a non-empty diff yields 1–`MAX_CHAPTERS` chapters; markers are the
 * contiguous `§ 01`… equal to `order`; the output is order-independent.
 */
export function fileBasedChapters(hunks: readonly ParsedHunk[]): FileChapter[] {
  // Canonical dedup (not last-write-wins) so the output is a pure function of
  // the hunk set — see dedupeHunks. `createRevision` already deduped, but this
  // keeps fileBasedChapters independently order-independent.
  const distinct = dedupeHunks(hunks);
  if (distinct.length === 0) return [];

  // Primary buckets: top-level directory.
  const dirs = new Map<string, Group>();
  for (const h of distinct) {
    const info = topDir(h.filePath);
    const key = dirKey(info);
    let g = dirs.get(key);
    if (!g) {
      g = { isRoot: info.isRoot, dir: info.dir, ext: null, isOverflow: false, hunks: [] };
      dirs.set(key, g);
    }
    g.hunks.push(h);
  }

  // With < 3 directories, refine by extension to spend the chapter budget on
  // reaching the floor; with ≥ 3 the directory granularity already meets it and
  // stays coarser and more legible.
  const granularity: Granularity = dirs.size >= 3 ? 'dir' : 'ext';
  let groups: Group[];
  if (granularity === 'dir') {
    groups = [...dirs.values()];
  } else {
    const sub = new Map<string, Group>();
    for (const h of distinct) {
      const info = topDir(h.filePath);
      const e = ext(h.filePath);
      const key = extKey(info, e);
      let g = sub.get(key);
      if (!g) {
        g = { isRoot: info.isRoot, dir: info.dir, ext: e, isOverflow: false, hunks: [] };
        sub.set(key, g);
      }
      g.hunks.push(h);
    }
    groups = [...sub.values()];
  }

  if (groups.length > MAX_CHAPTERS) groups = capGroups(groups, granularity);

  groups.sort((a, b) => cmpDisplay(a, b, granularity));
  return groups.map((g, i) => {
    const order = i + 1;
    return {
      marker: `§ ${String(order).padStart(2, '0')}`,
      title: titleFor(g, granularity),
      summary: null,
      order,
      hunkIds: orderedHunkIds(g.hunks),
    };
  });
}

/**
 * Persist a chapter set for one revision into `chapters` + `chapter_hunks`.
 *
 * `revision_id` and `pull_id` are passed by the caller from the owning revision
 * row — never from any request payload (design.md § Writer invariants). Must run
 * inside the `createRevision` transaction so a partial write rolls back with the
 * revision. `inherited_from_chapter_id` is left NULL: inheritance is a
 * prompt-level LLM hint (SPEC.md § Chapter inheritance), absent from this path.
 */
export function insertChapters(
  db: Database,
  revisionId: number,
  pullId: number,
  chapters: readonly FileChapter[],
): void {
  const insertChapter = db.query<
    { id: number },
    [number, number, string, string, string | null, number]
  >(
    `INSERT INTO chapters (revision_id, pull_id, marker, title, summary, "order")
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insertLink = db.query(
    `INSERT INTO chapter_hunks (chapter_id, hunk_id, "order") VALUES (?, ?, ?)`,
  );
  for (const ch of chapters) {
    const row = insertChapter.get(revisionId, pullId, ch.marker, ch.title, ch.summary, ch.order)!;
    ch.hunkIds.forEach((hunkId, i) => insertLink.run(row.id, hunkId, i + 1));
  }
}
