import { describe, it, expect } from 'vitest';
import type {
  ChapterHunkRow,
  ChapterRow,
  HunkRow,
  PullRow,
  RevisionSnapshot,
} from './db/snapshot.ts';
import {
  agentChip,
  buildRevisionView,
  hunkLines,
  lineStats,
  rangeLabel,
  statusLabel,
  UNCHAPTERED_ID,
  type RevisionView,
} from './revision-view.ts';
import { GOLDEN_REPO_SLUG, GOLDEN_SNAPSHOT, GOLDEN_VIEW } from './revision-view.fixture.ts';

// buildRevisionView is pure, so every case here is a hand-built snapshot; the DB
// read that produces snapshots is covered in db/snapshot.test.ts.

const PULL: PullRow = { id: 7, branch: 'feat/x', base: 'main', title: null, status: 'open' };

// Hunk ids must not be integer-like: JS orders integer keys first, which would
// mask the canonical-order assertions on `view.hunks`.
function hunk(id: string, file_path: string, over: Partial<HunkRow> = {}): HunkRow {
  return {
    id,
    file_path,
    start_line: 1,
    end_line: 1,
    content: '+x',
    kind: 'add',
    agent: null,
    confidence: 'high',
    ...over,
  };
}

const chapter = (id: number, order: number, title = `c${id}`): ChapterRow => ({
  id,
  marker: `§ ${String(order).padStart(2, '0')}`,
  title,
  summary: null,
  order,
});

const link = (chapter_id: number, hunk_id: string, order = 1): ChapterHunkRow => ({
  chapter_id,
  hunk_id,
  order,
});

function snap(over: Partial<RevisionSnapshot> = {}): RevisionSnapshot {
  return {
    pull: PULL,
    revisionNumber: 1,
    latestRevisionNumber: 1,
    hunks: [],
    chapters: [],
    chapterHunks: [],
    ...over,
  };
}

const view = (s: RevisionSnapshot) => buildRevisionView(s, 'demo');

// I1–I4 from the JSON contract, checked as a group.
function expectChapterInvariants(v: RevisionView): void {
  const keys = Object.keys(v.hunks);
  const listed = v.chapters.flatMap((c) => c.hunk_ids);
  for (const k of keys) expect(listed, `I1: ${k} is in no chapter`).toContain(k);
  for (const id of listed) expect(Object.hasOwn(v.hunks, id), `I2: ${id} dangles`).toBe(true);
  expect(v.chapters.length === 0, 'I3').toBe(keys.length === 0);
  expect(
    v.chapters.map((c) => c.active),
    'I4',
  ).toEqual(v.chapters.map((_, i) => i === 0));
}

describe('hunkLines', () => {
  it('numbers a mod hunk on the new side; removed lines carry no number', () => {
    expect(hunkLines(' a\n-b\n+c\n d', 10)).toEqual([
      { kind: 'ctx', no: '10', text: 'a' },
      { kind: 'del', no: '-', text: 'b' },
      { kind: 'add', no: '+11', text: 'c' },
      { kind: 'ctx', no: '12', text: 'd' },
    ]);
  });

  it('numbers an add-only hunk from the new-file start', () => {
    expect(hunkLines('+x\n+y', 1)).toEqual([
      { kind: 'add', no: '+1', text: 'x' },
      { kind: 'add', no: '+2', text: 'y' },
    ]);
  });

  it('numbers a pure removal on the old side from startLine', () => {
    expect(hunkLines('-p\n-q', 5)).toEqual([
      { kind: 'del', no: '-5', text: 'p' },
      { kind: 'del', no: '-6', text: 'q' },
    ]);
  });

  it('chooses the side from content: a removal with context lines is numbered on the new side', () => {
    expect(hunkLines(' a\n-b\n c', 7)).toEqual([
      { kind: 'ctx', no: '7', text: 'a' },
      { kind: 'del', no: '-', text: 'b' },
      { kind: 'ctx', no: '8', text: 'c' },
    ]);
  });

  it('ignores hunks.kind when building the view: a kind=del hunk with context is new-side', () => {
    const h = hunk('h-del', 'a.ts', {
      content: ' a\n-b\n c',
      start_line: 7,
      end_line: 8,
      kind: 'del',
    });
    const v = view(snap({ hunks: [h] }));
    expect(v.hunks['h-del']!.lines.map((l) => l.no)).toEqual(['7', '-', '8']);
    expect(v.hunks['h-del']!.kind).toBe('del');
  });

  it('keeps a backslash marker as meta without advancing the counter', () => {
    expect(hunkLines('-a\n\\ No newline at end of file\n+a', 3)).toEqual([
      { kind: 'del', no: '-', text: 'a' },
      { kind: 'meta', no: '', text: 'No newline at end of file' },
      { kind: 'add', no: '+3', text: 'a' },
    ]);
    expect(hunkLines(' a\n\\No space\n+b', 1)).toEqual([
      { kind: 'ctx', no: '1', text: 'a' },
      { kind: 'meta', no: '', text: 'No space' },
      { kind: 'add', no: '+2', text: 'b' },
    ]);
    // At most one space after the backslash is part of the marker.
    expect(hunkLines('\\  two', 1)).toEqual([{ kind: 'meta', no: '', text: ' two' }]);
  });

  it('strips exactly one marker character; leading whitespace and a trailing \\r are kept', () => {
    expect(hunkLines('+  x\n \tfoo\n+a\r', 1).map((l) => l.text)).toEqual(['  x', '\tfoo', 'a\r']);
  });

  it('returns no lines for empty content', () => {
    expect(hunkLines('', 1)).toEqual([]);
  });

  it('adds no line for a trailing newline', () => {
    expect(hunkLines('+x\n+y\n', 1)).toEqual(hunkLines('+x\n+y', 1));
    expect(hunkLines('+x\n+y\n', 1)).toHaveLength(2);
  });

  it('shows an unknown marker verbatim as meta without skipping the next number', () => {
    expect(hunkLines(' a\n?x\n+b', 1)).toEqual([
      { kind: 'ctx', no: '1', text: 'a' },
      { kind: 'meta', no: '', text: '?x' },
      { kind: 'add', no: '+2', text: 'b' },
    ]);
  });
});

describe('rangeLabel', () => {
  it.each([
    [' a\n+b', 5, 7, 'L5-7'],
    [' a', 5, 5, 'L5'],
    ['-a\n-b', 1, 2, 'base L1-2'],
    ['-a', 4, 4, 'base L4'],
  ])('(%j, %i, %i) → %s', (content, start, end, expected) => {
    expect(rangeLabel(content, start, end)).toBe(expected);
  });

  it('is new-side when any context or added line exists alongside removals', () => {
    expect(rangeLabel(' a\n-b', 3, 4)).toBe('L3-4');
    expect(rangeLabel('-a\n+b', 3, 3)).toBe('L3');
  });

  it('does not treat a backslash marker as a new-side line', () => {
    expect(rangeLabel('-a\n\\ No newline at end of file', 4, 4)).toBe('base L4');
  });

  it('uses the stored start and end, not a count of the content lines', () => {
    expect(rangeLabel('+a', 10, 40)).toBe('L10-40');
  });
});

describe('lineStats', () => {
  it('counts + and - lines; context and backslash lines never count', () => {
    expect(lineStats('+a\n-b\n c\n\\ No newline')).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts a removed line whose text starts with -- once', () => {
    expect(lineStats('---x')).toEqual({ additions: 0, deletions: 1 });
    expect(lineStats('+++y')).toEqual({ additions: 1, deletions: 0 });
  });

  it('sums over the revision; files counts distinct paths', () => {
    const v = view(
      snap({
        hunks: [
          hunk('h-a1', 'a.ts', { content: '+1\n+2\n-3' }),
          hunk('h-a2', 'a.ts', { content: '-4', start_line: 9, end_line: 9 }),
          hunk('h-b', 'b.ts', { content: ' 5\n+6' }),
        ],
      }),
    );
    expect(v.stats).toEqual({ additions: 3, deletions: 2, files: 2 });
  });
});

describe('buildRevisionView — pull', () => {
  it.each([
    [null, 'feat/x'],
    ['  ', 'feat/x'],
    ['X', 'X'],
    [' X ', ' X '],
  ])('title %j → %j (branch when blank, otherwise verbatim)', (title, expected) => {
    expect(view(snap({ pull: { ...PULL, title } })).pull.title).toBe(expected);
  });

  it.each([
    ['open', 'Open'],
    ['merged', 'Merged'],
    ['closed', 'Closed'],
  ] as const)('status %s → %s', (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
    expect(view(snap({ pull: { ...PULL, status } })).pull.status).toBe(expected);
  });

  it('number is the local pull id; branch, base and revision numbers pass through', () => {
    const v = buildRevisionView(snap({ revisionNumber: 2, latestRevisionNumber: 3 }), 'my-repo');
    expect(v.pull).toEqual({
      id: 7,
      number: 7,
      title: 'feat/x',
      branch: 'feat/x',
      base: 'main',
      status: 'Open',
    });
    expect(v.revision_number).toBe(2);
    expect(v.latest_revision_number).toBe(3);
    expect(v.repo_slug).toBe('my-repo');
    expect(v.session).toBeNull();
    expect(v.reviewers).toEqual([]);
  });
});

describe('agentChip', () => {
  it('renders a NULL agent as unattributed, never human', () => {
    expect(agentChip(null)).toEqual({ name: 'unattributed', kind: 'muted', initial: '?' });
  });

  it.each([
    ['claude-sonnet-4-6', { name: 'claude-sonnet-4-6', kind: 'claude', initial: 'C' }],
    ['cursor-tab', { name: 'cursor-tab', kind: 'codex', initial: 'C' }],
    ['human', { name: 'human', kind: 'muted', initial: 'H' }],
    ['---', { name: '---', kind: 'muted', initial: '?' }],
  ])('%j → %j', (agent, expected) => {
    expect(agentChip(agent)).toEqual(expected);
  });

  it.each([
    ['Claude Code', 'claude'],
    ['codex-cli', 'codex'],
    ['GitHub Copilot', 'codex'],
    ['GPT-5', 'codex'],
    ['claude-via-cursor', 'claude'],
    ['gemini', 'muted'],
  ])('kind of %j is %s (case-insensitive, claude checked first)', (agent, kind) => {
    expect(agentChip(agent).kind).toBe(kind);
  });

  it('takes the first ASCII alphanumeric character, upper-cased, as the initial', () => {
    expect(agentChip('_bot').initial).toBe('B');
    expect(agentChip('9lives').initial).toBe('9');
    expect(agentChip('élan').initial).toBe('L');
  });

  it('keeps the agent string verbatim as the name', () => {
    expect(agentChip('  Claude <x>  ').name).toBe('  Claude <x>  ');
  });

  it('treats a blank agent like NULL', () => {
    expect(agentChip('')).toEqual(agentChip(null));
    expect(agentChip('   ')).toEqual(agentChip(null));
  });
});

describe('buildRevisionView — authors', () => {
  it('lists distinct chips by hunk count desc, then name', () => {
    const v = view(
      snap({
        hunks: [
          hunk('h-1', 'a.ts', { agent: 'b' }),
          hunk('h-2', 'b.ts', { agent: 'a' }),
          hunk('h-3', 'c.ts', { agent: 'a' }),
          hunk('h-4', 'd.ts', { agent: null }),
        ],
      }),
    );
    expect(v.authors).toEqual([agentChip('a'), agentChip('b'), agentChip(null)]);
  });

  it('breaks count ties with JS < (code units), not locale order', () => {
    const v = view(
      snap({
        hunks: [hunk('h-1', 'a.ts', { agent: 'alice' }), hunk('h-2', 'b.ts', { agent: 'Zed' })],
      }),
    );
    expect(v.authors.map((a) => a.name)).toEqual(['Zed', 'alice']);
  });

  it('collapses all-NULL agents into one unattributed chip', () => {
    const v = view(snap({ hunks: [hunk('h-1', 'a.ts'), hunk('h-2', 'b.ts')] }));
    expect(v.authors).toEqual([{ name: 'unattributed', kind: 'muted', initial: '?' }]);
  });

  it('counts a blank agent under the same unattributed chip as NULL', () => {
    const v = view(
      snap({
        hunks: [
          hunk('h-1', 'a.ts', { agent: null }),
          hunk('h-2', 'b.ts', { agent: '' }),
          hunk('h-3', 'c.ts', { agent: 'b' }),
        ],
      }),
    );
    expect(v.authors).toEqual([agentChip(null), agentChip('b')]);
  });

  it('is empty when there are no hunks', () => {
    expect(view(snap()).authors).toEqual([]);
  });

  it('gives each hunk its own agent chip', () => {
    const v = view(snap({ hunks: [hunk('h-1', 'a.ts', { agent: 'codex' })] }));
    expect(v.hunks['h-1']!.agent).toEqual(agentChip('codex'));
  });
});

describe('buildRevisionView — confidence', () => {
  it.each(['high', 'weird'])('passes %j through verbatim', (confidence) => {
    const v = view(snap({ hunks: [hunk('h-1', 'a.ts', { confidence })] }));
    expect(v.hunks['h-1']!.confidence).toBe(confidence);
  });
});

describe('buildRevisionView — chapters', () => {
  it('sorts hunk_ids by chapter_hunks order and chapters by order', () => {
    const v = view(
      snap({
        hunks: [hunk('x', 'a.ts'), hunk('y', 'b.ts')],
        chapters: [chapter(1, 2, 'second'), chapter(2, 1, 'first')],
        chapterHunks: [link(2, 'x', 2), link(2, 'y', 1), link(1, 'x', 1)],
      }),
    );
    expect(v.chapters.map((c) => c.title)).toEqual(['first', 'second']);
    expect(v.chapters.map((c) => c.id)).toEqual(['2', '1']);
    expect(v.chapters[0]!.hunk_ids).toEqual(['y', 'x']);
  });

  it('breaks an order tie on chapter id, and a link-order tie on hunk id', () => {
    const v = view(
      snap({
        hunks: [hunk('p', 'a.ts'), hunk('q', 'b.ts'), hunk('r', 'c.ts')],
        chapters: [chapter(5, 1, 'five'), chapter(3, 1, 'three')],
        chapterHunks: [link(5, 'r'), link(3, 'q', 1), link(3, 'p', 1)],
      }),
    );
    expect(v.chapters.map((c) => c.title)).toEqual(['three', 'five']);
    expect(v.chapters[0]!.hunk_ids).toEqual(['p', 'q']);
  });

  it('carries marker, title and summary from the chapter row', () => {
    const v = view(
      snap({
        hunks: [hunk('h-1', 'a.ts')],
        chapters: [{ id: 4, marker: '§ 09', title: 'T', summary: 'why', order: 9 }],
        chapterHunks: [link(4, 'h-1')],
      }),
    );
    expect(v.chapters).toEqual([
      {
        id: '4',
        order: 9,
        marker: '§ 09',
        title: 'T',
        heading: null,
        summary: 'why',
        active: true,
        read: null,
        read_time: null,
        spans: ['a.ts'],
        hunk_ids: ['h-1'],
        session: null,
      },
    ]);
  });

  it('lists distinct spans in order of first appearance in hunk_ids', () => {
    const v = view(
      snap({
        hunks: [
          hunk('h-a1', 'a.ts'),
          hunk('h-a9', 'a.ts', { start_line: 9, end_line: 9 }),
          hunk('h-b', 'b.ts'),
        ],
        chapters: [chapter(1, 1)],
        chapterHunks: [link(1, 'h-b', 1), link(1, 'h-a9', 2), link(1, 'h-a1', 3)],
      }),
    );
    expect(v.chapters[0]!.spans).toEqual(['b.ts', 'a.ts']);
  });

  describe('I2 — every hunk_ids entry is a hunks key', () => {
    it('drops chapter_hunks ids that are not in this revision', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts')],
          chapters: [chapter(1, 1)],
          chapterHunks: [link(1, 'gone', 1), link(1, 'h-1', 2)],
        }),
      );
      expect(v.chapters[0]!.hunk_ids).toEqual(['h-1']);
      expect(v.chapters[0]!.spans).toEqual(['a.ts']);
      expectChapterInvariants(v);
    });

    it('drops a dangling id that names an Object.prototype member', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts')],
          chapters: [chapter(1, 1)],
          chapterHunks: [
            link(1, 'h-1', 1),
            link(1, 'toString', 2),
            link(1, 'constructor', 3),
            link(1, '__proto__', 4),
          ],
        }),
      );
      expect(v.chapters[0]!.hunk_ids).toEqual(['h-1']);
      expect(v.chapters[0]!.spans).toEqual(['a.ts']);
      expectChapterInvariants(v);
    });
  });

  describe('I1 — every hunk is in some chapter', () => {
    it('puts a hunk no chapter covers into a trailing Unchaptered chapter', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts'), hunk('h-2', 'b.ts')],
          chapters: [chapter(1, 1), chapter(2, 4)],
          chapterHunks: [link(1, 'h-1'), link(2, 'h-1')],
        }),
      );
      expect(v.chapters.map((c) => c.id)).toEqual(['1', '2', UNCHAPTERED_ID]);
      expect(v.chapters.at(-1)).toEqual({
        id: 'unchaptered',
        order: 5,
        marker: '§ —',
        title: 'Unchaptered',
        heading: null,
        summary: null,
        active: false,
        read: null,
        read_time: null,
        spans: ['b.ts'],
        hunk_ids: ['h-2'],
        session: null,
      });
      expectChapterInvariants(v);
    });

    it('orders Unchaptered after every chapter row, including rows dropped as empty', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts'), hunk('h-2', 'b.ts')],
          chapters: [chapter(1, 1), chapter(2, 6)],
          chapterHunks: [link(1, 'h-1'), link(2, 'gone')],
        }),
      );
      expect(v.chapters.map((c) => [c.id, c.order])).toEqual([
        ['1', 1],
        [UNCHAPTERED_ID, 7],
      ]);
    });

    it('with no chapter rows, emits one active Unchaptered chapter holding every hunk in canonical order', () => {
      const v = view(
        snap({
          hunks: [
            hunk('h-c', 'c.ts'),
            hunk('h-a5', 'a.ts', { start_line: 5, end_line: 5 }),
            hunk('h-a1', 'a.ts'),
          ],
        }),
      );
      expect(v.chapters).toEqual([
        {
          id: 'unchaptered',
          order: 1,
          marker: '§ —',
          title: 'Unchaptered',
          heading: null,
          summary: null,
          active: true,
          read: null,
          read_time: null,
          spans: ['a.ts', 'c.ts'],
          hunk_ids: ['h-a1', 'h-a5', 'h-c'],
          session: null,
        },
      ]);
      expectChapterInvariants(v);
    });
  });

  describe('I3 — chapters is empty exactly when hunks is', () => {
    it('drops a chapter whose ids all dangle', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts')],
          chapters: [chapter(1, 1), chapter(2, 2)],
          chapterHunks: [link(1, 'gone'), link(2, 'h-1')],
        }),
      );
      expect(v.chapters.map((c) => c.id)).toEqual(['2']);
      expectChapterInvariants(v);
    });

    it('drops a chapter with no chapter_hunks rows at all', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts')],
          chapters: [chapter(1, 1), chapter(2, 2)],
          chapterHunks: [link(2, 'h-1')],
        }),
      );
      expect(v.chapters.map((c) => c.id)).toEqual(['2']);
    });

    it('emits an empty view for a revision with zero hunks, even when chapter rows exist', () => {
      for (const s of [
        snap(),
        snap({ chapters: [chapter(1, 1)], chapterHunks: [link(1, 'gone')] }),
      ]) {
        const v = view(s);
        expect({
          chapters: v.chapters,
          hunks: v.hunks,
          authors: v.authors,
          stats: v.stats,
        }).toEqual({
          chapters: [],
          hunks: {},
          authors: [],
          stats: { additions: 0, deletions: 0, files: 0 },
        });
        expectChapterInvariants(v);
      }
    });
  });

  describe('I4 — exactly one active chapter, the first', () => {
    it('marks only the first of three chapters active; ids are String(row.id)', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts'), hunk('h-2', 'b.ts'), hunk('h-3', 'c.ts')],
          chapters: [chapter(12, 1), chapter(40, 2), chapter(3, 3)],
          chapterHunks: [link(12, 'h-1'), link(40, 'h-2'), link(3, 'h-3')],
        }),
      );
      expect(v.chapters.map((c) => c.active)).toEqual([true, false, false]);
      expect(v.chapters.map((c) => c.id)).toEqual(['12', '40', '3']);
    });

    it('moves active to the first emitted chapter when the first row is dropped', () => {
      const v = view(
        snap({
          hunks: [hunk('h-1', 'a.ts')],
          chapters: [chapter(1, 1), chapter(2, 2)],
          chapterHunks: [link(1, 'gone'), link(2, 'h-1')],
        }),
      );
      expect(v.chapters.map((c) => [c.id, c.active])).toEqual([['2', true]]);
    });
  });
});

describe('buildRevisionView — hunk order', () => {
  it('compares start_line and end_line as numbers, in hunks and in Unchaptered hunk_ids', () => {
    const v = view(
      snap({
        hunks: [
          hunk('h-100', 'a.ts', { start_line: 100, end_line: 100 }),
          hunk('h-9-10', 'a.ts', { start_line: 9, end_line: 10 }),
          hunk('h-20', 'a.ts', { start_line: 20, end_line: 20 }),
          hunk('h-9-9', 'a.ts', { start_line: 9, end_line: 9 }),
        ],
      }),
    );
    const canonical = ['h-9-9', 'h-9-10', 'h-20', 'h-100'];
    expect(Object.keys(v.hunks)).toEqual(canonical);
    expect(v.chapters[0]!.hunk_ids).toEqual(canonical);
  });
});

describe('buildRevisionView — I5: output is independent of row order', () => {
  // Every sort key has a tie here, and each tie-breaker disagrees with the next
  // key's order, so dropping any one of them changes the output:
  // - hunks: same (file, start), same (file, start, end); start vs end order differ
  // - chapters sharing an order; links sharing an order; authors sharing a count
  // - plus a dangling link, a dropped chapter and an uncovered hunk
  const RICH = snap({
    hunks: [
      hunk('h-a', 'src/a.ts', {
        content: ' a\n-b\n+c',
        end_line: 5,
        kind: 'mod',
        agent: 'claude-x',
      }),
      hunk('h-b', 'src/a.ts', { content: '+x', end_line: 3, agent: 'codex' }),
      hunk('h-c2', 'src/a.ts', { start_line: 2, end_line: 2, agent: null }),
      hunk('h-c1', 'src/a.ts', { start_line: 2, end_line: 2, agent: 'codex' }),
      hunk('h-d', 'lib/z.ts', {
        content: '-z',
        start_line: 4,
        end_line: 4,
        kind: 'del',
        agent: 'claude-x',
      }),
      hunk('h-e', 'README.md', { content: '+r' }),
      hunk('h-f', 'Zeta.md', { agent: 'Zed' }),
    ],
    chapters: [
      chapter(3, 1, 'A'),
      chapter(1, 1, 'B'),
      chapter(2, 2, 'C'),
      chapter(9, 7, 'dropped'),
    ],
    chapterHunks: [
      link(3, 'h-a', 1),
      link(3, 'h-b', 1),
      link(3, 'ghost', 0),
      link(1, 'h-c1', 2),
      link(1, 'h-c2', 1),
      link(2, 'h-d', 1),
      link(2, 'h-f', 1),
      link(9, 'nope', 1),
    ],
  });

  // Seeded LCG + Fisher–Yates, so a failure reproduces from its seed.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  function variants(s: RevisionSnapshot): RevisionSnapshot[] {
    return Array.from({ length: 20 }, (_, seed) => {
      const rand = rng(seed + 1);
      return {
        ...s,
        hunks: shuffled(s.hunks, rand),
        chapters: shuffled(s.chapters, rand),
        chapterHunks: shuffled(s.chapterHunks, rand),
      };
    });
  }

  it('shuffles actually permute each row array', () => {
    const vs = variants(RICH);
    expect(new Set(vs.map((v) => v.hunks.map((h) => h.id).join())).size).toBeGreaterThan(1);
    expect(new Set(vs.map((v) => v.chapters.map((c) => c.id).join())).size).toBeGreaterThan(1);
    expect(
      new Set(vs.map((v) => v.chapterHunks.map((l) => l.hunk_id).join())).size,
    ).toBeGreaterThan(1);
  });

  it.each([
    ['a snapshot with a tie on every sort key', RICH],
    ['the golden snapshot', GOLDEN_SNAPSHOT],
  ])('20 shuffles of %s give identical JSON', (_, s) => {
    const expected = JSON.stringify(view(s));
    for (const v of variants(s)) expect(JSON.stringify(view(v))).toBe(expected);
    expect(JSON.stringify(view({ ...s, hunks: [...s.hunks].reverse() }))).toBe(expected);
  });

  it('resolves every tie deterministically', () => {
    const v = view(RICH);
    expect(Object.keys(v.hunks)).toEqual(['h-e', 'h-f', 'h-d', 'h-b', 'h-a', 'h-c1', 'h-c2']);
    expect(v.chapters.map((c) => [c.id, c.hunk_ids])).toEqual([
      ['1', ['h-c2', 'h-c1']],
      ['3', ['h-a', 'h-b']],
      ['2', ['h-d', 'h-f']],
      [UNCHAPTERED_ID, ['h-e']],
    ]);
    expect(v.chapters.at(-1)!.order).toBe(8);
    expect(v.authors.map((a) => a.name)).toEqual(['claude-x', 'codex', 'unattributed', 'Zed']);
    expectChapterInvariants(v);
  });

  it('does not mutate the snapshot', () => {
    const frozen: RevisionSnapshot = Object.freeze({
      ...RICH,
      hunks: Object.freeze([...RICH.hunks]),
      chapters: Object.freeze([...RICH.chapters]),
      chapterHunks: Object.freeze([...RICH.chapterHunks]),
    });
    expect(JSON.stringify(view(frozen))).toBe(JSON.stringify(view(RICH)));
  });
});

describe('buildRevisionView — golden', () => {
  it('builds GOLDEN_VIEW from GOLDEN_SNAPSHOT', () => {
    expect(buildRevisionView(GOLDEN_SNAPSHOT, GOLDEN_REPO_SLUG)).toStrictEqual(GOLDEN_VIEW);
  });

  it('inserts hunks in canonical order: README.md, lib/old.ts, src/a.ts', () => {
    const v = buildRevisionView(GOLDEN_SNAPSHOT, GOLDEN_REPO_SLUG);
    expect(Object.keys(v.hunks).map((id) => v.hunks[id]!.file_path)).toEqual([
      'README.md',
      'lib/old.ts',
      'src/a.ts',
    ]);
    expect(Object.keys(v.hunks)).toEqual(Object.keys(GOLDEN_VIEW.hunks));
    expectChapterInvariants(v);
  });
});
