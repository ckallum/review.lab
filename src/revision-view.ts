import type { HunkRow, PullRow, RevisionSnapshot } from './db/snapshot.ts';

/**
 * The JSON contract for `GET /api/pr/:id/rev/:n` (T1.9) and the pure builder that
 * produces it from a `RevisionSnapshot`. `web/index.html`'s `renderRevision` consumes
 * this shape.
 *
 * - Strings are raw and unescaped; the page's `esc()` is the only escaping point.
 * - Every key is always present: missing data is `null` or `[]`, never an absent key.
 * - Output is a pure function of the snapshot's row *sets*: every array is sorted
 *   here, so row order from SQLite never reaches the response.
 */

export type LineKind = 'ctx' | 'add' | 'del' | 'meta';

export interface HunkLine {
  readonly kind: LineKind;
  /** Display number: `'12'` context, `'+12'` added, `'-12'` or `'-'` removed, `''` meta. */
  readonly no: string;
  readonly text: string;
}

export interface AuthorChip {
  readonly name: string;
  readonly kind: 'claude' | 'codex' | 'muted';
  readonly initial: string;
}

export interface HunkView {
  readonly file_path: string;
  readonly kind: HunkRow['kind'];
  readonly range_label: string;
  readonly agent: AuthorChip;
  readonly confidence: string;
  readonly lines: readonly HunkLine[];
}

export interface ChapterView {
  readonly id: string;
  readonly order: number;
  readonly marker: string;
  readonly title: string;
  readonly heading: null;
  readonly summary: string | null;
  readonly active: boolean;
  readonly read: null;
  readonly read_time: null;
  readonly spans: readonly string[];
  readonly hunk_ids: readonly string[];
  readonly session: null;
}

export interface RevisionView {
  readonly repo_slug: string;
  readonly pull: {
    readonly id: number;
    /** The local `pulls.id`, so `#N` matches `/pr/N`; no GitHub number exists yet. */
    readonly number: number;
    readonly title: string;
    readonly branch: string;
    readonly base: string;
    readonly status: 'Open' | 'Merged' | 'Closed';
  };
  readonly revision_number: number;
  readonly latest_revision_number: number;
  readonly stats: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
  };
  readonly authors: readonly AuthorChip[];
  readonly chapters: readonly ChapterView[];
  /** Keyed by content-hash id, inserted in canonical `(file_path, start_line, end_line, id)` order. */
  readonly hunks: Readonly<Record<string, HunkView>>;
  readonly session: null;
  readonly reviewers: readonly [];
}

/** Id of the synthetic chapter that holds hunks no chapter row covers. */
export const UNCHAPTERED_ID = 'unchaptered';

/** UTF-16 code-unit order, never `localeCompare`, so output is machine-independent. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when any line is context or added, i.e. the hunk's `start_line` is on the new side. */
function hasNewSideLine(lines: readonly string[]): boolean {
  return lines.some((l) => l[0] === ' ' || l[0] === '+');
}

/**
 * Turn a stored hunk body into numbered display lines.
 *
 * - The side is decided by content, not `kind`: any context or added line means
 *   `startLine` is the new-file start (parseDiff's `newCount > 0`); otherwise it is
 *   the old-file start of a pure removal.
 * - A removed line in a hunk that also has new-side lines gets `no: '-'`: the old
 *   start line isn't stored, so no number is invented.
 * - Exactly one marker character is stripped; `\` lines become `meta` without
 *   advancing the counter; an unrecognised marker is shown verbatim as `meta`.
 */
export function hunkLines(content: string, startLine: number): HunkLine[] {
  if (content === '') return [];
  const raw = content.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const newSide = hasNewSideLine(raw);
  let n = startLine;
  return raw.map((l): HunkLine => {
    const text = l.slice(1);
    switch (l[0]) {
      case ' ':
        return { kind: 'ctx', no: String(n++), text };
      case '+':
        return { kind: 'add', no: `+${n++}`, text };
      case '-':
        return newSide ? { kind: 'del', no: '-', text } : { kind: 'del', no: `-${n++}`, text };
      case '\\':
        return { kind: 'meta', no: '', text: l.replace(/^\\ ?/, '') };
      default:
        return { kind: 'meta', no: '', text: l };
    }
  });
}

/** `L5-7` / `L5`, prefixed `base ` when the range is old-file lines (a pure removal). */
export function rangeLabel(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  const oldSide = lines.some((l) => l[0] === '-') && !hasNewSideLine(lines);
  const range = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
  return (oldSide ? 'base ' : '') + range;
}

/** Count added and removed lines in a stored hunk body; context and `\` lines don't count. */
export function lineStats(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of content.split('\n')) {
    if (l[0] === '+') additions++;
    else if (l[0] === '-') deletions++;
  }
  return { additions, deletions };
}

/**
 * Display chip for `hunks.agent`. NULL (or blank) is `unattributed`, not `human`:
 * the column stays NULL until attribution (T2.6) writes it, and labelling
 * agent-written code as human would be false provenance.
 */
export function agentChip(agent: string | null): AuthorChip {
  if (agent === null || agent.trim() === '') {
    return { name: 'unattributed', kind: 'muted', initial: '?' };
  }
  const first = agent.match(/[A-Za-z0-9]/);
  return { name: agent, kind: chipKind(agent), initial: first ? first[0].toUpperCase() : '?' };
}

function chipKind(agent: string): AuthorChip['kind'] {
  if (/claude/i.test(agent)) return 'claude';
  if (/codex|cursor|copilot|gpt/i.test(agent)) return 'codex';
  return 'muted';
}

// Total over the pulls.status CHECK values, so a new status is a compile error, not 'Open'.
const STATUS_LABEL: Record<PullRow['status'], RevisionView['pull']['status']> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

export function statusLabel(status: PullRow['status']): RevisionView['pull']['status'] {
  return STATUS_LABEL[status];
}

function byCanonicalHunkOrder(a: HunkRow, b: HunkRow): number {
  if (a.file_path !== b.file_path) return compareCodeUnits(a.file_path, b.file_path);
  if (a.start_line !== b.start_line) return a.start_line - b.start_line;
  if (a.end_line !== b.end_line) return a.end_line - b.end_line;
  return compareCodeUnits(a.id, b.id);
}

function chapterView(
  id: string,
  order: number,
  marker: string,
  title: string,
  summary: string | null,
  hunkIds: readonly string[],
  hunks: Readonly<Record<string, HunkView>>,
): ChapterView {
  const spans = [...new Set(hunkIds.map((hid) => hunks[hid]!.file_path))];
  return {
    id,
    order,
    marker,
    title,
    heading: null,
    summary,
    active: false,
    read: null,
    read_time: null,
    spans,
    hunk_ids: hunkIds,
    session: null,
  };
}

/**
 * Build the page's JSON from one revision's rows.
 *
 * Chapter invariants (each pinned by a test):
 * - I1: every hunk appears in some chapter — hunks no chapter row covers (e.g. a
 *   revision published before T1.8) go into a trailing `Unchaptered` chapter.
 * - I2: every chapter `hunk_ids` entry is a key of `hunks`; dangling ids are dropped.
 * - I3: `chapters` is empty exactly when `hunks` is — a chapter left with no hunks is dropped.
 * - I4: exactly one chapter is `active` (the first) when any exist.
 */
export function buildRevisionView(s: RevisionSnapshot, repoSlug: string): RevisionView {
  const hunkRows = [...s.hunks].sort(byCanonicalHunkOrder);
  const hunks: Record<string, HunkView> = {};
  const authorCounts = new Map<string, { chip: AuthorChip; n: number }>();
  let additions = 0;
  let deletions = 0;
  for (const h of hunkRows) {
    const chip = agentChip(h.agent);
    hunks[h.id] = {
      file_path: h.file_path,
      kind: h.kind,
      range_label: rangeLabel(h.content, h.start_line, h.end_line),
      agent: chip,
      confidence: h.confidence,
      lines: hunkLines(h.content, h.start_line),
    };
    const st = lineStats(h.content);
    additions += st.additions;
    deletions += st.deletions;
    const author = authorCounts.get(chip.name) ?? { chip, n: 0 };
    author.n++;
    authorCounts.set(chip.name, author);
  }

  const links = new Map<number, { hunk_id: string; order: number }[]>();
  for (const l of s.chapterHunks) {
    const list = links.get(l.chapter_id) ?? [];
    list.push(l);
    links.set(l.chapter_id, list);
  }
  const chapterRows = [...s.chapters].sort((a, b) => a.order - b.order || a.id - b.id);
  const covered = new Set<string>();
  const chapters: ChapterView[] = [];
  for (const c of chapterRows) {
    const ids = (links.get(c.id) ?? [])
      .sort((a, b) => a.order - b.order || compareCodeUnits(a.hunk_id, b.hunk_id))
      .map((l) => l.hunk_id)
      .filter((hid) => Object.hasOwn(hunks, hid));
    if (ids.length === 0) continue;
    ids.forEach((hid) => covered.add(hid));
    chapters.push(chapterView(String(c.id), c.order, c.marker, c.title, c.summary, ids, hunks));
  }
  const uncovered = hunkRows.map((h) => h.id).filter((hid) => !covered.has(hid));
  if (uncovered.length > 0) {
    const order = Math.max(0, ...s.chapters.map((c) => c.order)) + 1;
    chapters.push(chapterView(UNCHAPTERED_ID, order, '§ —', 'Unchaptered', null, uncovered, hunks));
  }
  const withActive = chapters.map((c, i) => ({ ...c, active: i === 0 }));

  const authors = [...authorCounts.values()]
    .sort((a, b) => b.n - a.n || compareCodeUnits(a.chip.name, b.chip.name))
    .map((e) => e.chip);

  const title = s.pull.title !== null && s.pull.title.trim() !== '' ? s.pull.title : s.pull.branch;
  return {
    repo_slug: repoSlug,
    pull: {
      id: s.pull.id,
      number: s.pull.id,
      title,
      branch: s.pull.branch,
      base: s.pull.base,
      status: statusLabel(s.pull.status),
    },
    revision_number: s.revisionNumber,
    latest_revision_number: s.latestRevisionNumber,
    stats: { additions, deletions, files: new Set(hunkRows.map((h) => h.file_path)).size },
    authors,
    chapters: withActive,
    hunks,
    session: null,
    reviewers: [],
  };
}
