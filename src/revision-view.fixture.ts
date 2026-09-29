import type { RevisionSnapshot } from './db/snapshot.ts';
import type { RevisionView } from './revision-view.ts';

// Test-only golden for the revision view (T1.9). One diff, three hunks: a README
// edit ending in a "\ No newline" marker, a deleted file (old-side numbering), and
// a created file. The pure, DB, route, and page tests all use it, so the JSON the
// server emits is exactly what the page test renders. Published as branch
// feat/readme on base main, served from a repo root whose basename is "demo".

export const GOLDEN_DIFF = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,3 +1,3 @@',
  ' # demo',
  '-old line',
  '+new line',
  ' end',
  '\\ No newline at end of file',
  'diff --git a/lib/old.ts b/lib/old.ts',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/lib/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-const x = 1;',
  '-export default x;',
  'diff --git a/src/a.ts b/src/a.ts',
  'new file mode 100644',
  'index 0000000..4444444',
  '--- /dev/null',
  '+++ b/src/a.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  '',
].join('\n');

export const GOLDEN_BRANCH = 'feat/readme';
export const GOLDEN_BASE = 'main';
export const GOLDEN_REPO_SLUG = 'demo';

export const GOLDEN_SNAPSHOT: RevisionSnapshot = {
  pull: {
    id: 1,
    branch: 'feat/readme',
    base: 'main',
    title: null,
    status: 'open',
  },
  revisionNumber: 1,
  latestRevisionNumber: 1,
  hunks: [
    {
      id: '6680471c81c0fa23f8f36f9a4f450404efab0f4f97cb8dccc9b338db1769e279',
      file_path: 'README.md',
      start_line: 1,
      end_line: 3,
      content: ' # demo\n-old line\n+new line\n end\n\\ No newline at end of file',
      kind: 'mod',
      agent: null,
      confidence: 'high',
    },
    {
      id: 'e70904541358e4497b1c3fc946c2cca75c11a882b80c836ba85d686343c1a864',
      file_path: 'lib/old.ts',
      start_line: 1,
      end_line: 2,
      content: '-const x = 1;\n-export default x;',
      kind: 'del',
      agent: null,
      confidence: 'high',
    },
    {
      id: '7f243b2054cc2963bf4d89e170415b0eef0fcfae0001e168f169569770074fcd',
      file_path: 'src/a.ts',
      start_line: 1,
      end_line: 2,
      content: '+export const a = 1;\n+export const b = 2;',
      kind: 'add',
      agent: null,
      confidence: 'high',
    },
  ],
  chapters: [
    {
      id: 1,
      marker: '§ 01',
      title: 'lib',
      summary: null,
      order: 1,
    },
    {
      id: 2,
      marker: '§ 02',
      title: 'src',
      summary: null,
      order: 2,
    },
    {
      id: 3,
      marker: '§ 03',
      title: '(root)',
      summary: null,
      order: 3,
    },
  ],
  chapterHunks: [
    {
      chapter_id: 1,
      hunk_id: 'e70904541358e4497b1c3fc946c2cca75c11a882b80c836ba85d686343c1a864',
      order: 1,
    },
    {
      chapter_id: 2,
      hunk_id: '7f243b2054cc2963bf4d89e170415b0eef0fcfae0001e168f169569770074fcd',
      order: 1,
    },
    {
      chapter_id: 3,
      hunk_id: '6680471c81c0fa23f8f36f9a4f450404efab0f4f97cb8dccc9b338db1769e279',
      order: 1,
    },
  ],
};

export const GOLDEN_VIEW: RevisionView = {
  repo_slug: 'demo',
  pull: {
    id: 1,
    number: 1,
    title: 'feat/readme',
    branch: 'feat/readme',
    base: 'main',
    status: 'Open',
  },
  revision_number: 1,
  latest_revision_number: 1,
  stats: {
    additions: 3,
    deletions: 3,
    files: 3,
  },
  authors: [
    {
      name: 'unattributed',
      kind: 'muted',
      initial: '?',
    },
  ],
  chapters: [
    {
      id: '1',
      order: 1,
      marker: '§ 01',
      title: 'lib',
      heading: null,
      summary: null,
      active: true,
      read: null,
      read_time: null,
      spans: ['lib/old.ts'],
      hunk_ids: ['e70904541358e4497b1c3fc946c2cca75c11a882b80c836ba85d686343c1a864'],
      session: null,
    },
    {
      id: '2',
      order: 2,
      marker: '§ 02',
      title: 'src',
      heading: null,
      summary: null,
      active: false,
      read: null,
      read_time: null,
      spans: ['src/a.ts'],
      hunk_ids: ['7f243b2054cc2963bf4d89e170415b0eef0fcfae0001e168f169569770074fcd'],
      session: null,
    },
    {
      id: '3',
      order: 3,
      marker: '§ 03',
      title: '(root)',
      heading: null,
      summary: null,
      active: false,
      read: null,
      read_time: null,
      spans: ['README.md'],
      hunk_ids: ['6680471c81c0fa23f8f36f9a4f450404efab0f4f97cb8dccc9b338db1769e279'],
      session: null,
    },
  ],
  hunks: {
    '6680471c81c0fa23f8f36f9a4f450404efab0f4f97cb8dccc9b338db1769e279': {
      file_path: 'README.md',
      kind: 'mod',
      range_label: 'L1-3',
      agent: {
        name: 'unattributed',
        kind: 'muted',
        initial: '?',
      },
      confidence: 'high',
      lines: [
        {
          kind: 'ctx',
          no: '1',
          text: '# demo',
        },
        {
          kind: 'del',
          no: '-',
          text: 'old line',
        },
        {
          kind: 'add',
          no: '+2',
          text: 'new line',
        },
        {
          kind: 'ctx',
          no: '3',
          text: 'end',
        },
        {
          kind: 'meta',
          no: '',
          text: 'No newline at end of file',
        },
      ],
    },
    e70904541358e4497b1c3fc946c2cca75c11a882b80c836ba85d686343c1a864: {
      file_path: 'lib/old.ts',
      kind: 'del',
      range_label: 'base L1-2',
      agent: {
        name: 'unattributed',
        kind: 'muted',
        initial: '?',
      },
      confidence: 'high',
      lines: [
        {
          kind: 'del',
          no: '-1',
          text: 'const x = 1;',
        },
        {
          kind: 'del',
          no: '-2',
          text: 'export default x;',
        },
      ],
    },
    '7f243b2054cc2963bf4d89e170415b0eef0fcfae0001e168f169569770074fcd': {
      file_path: 'src/a.ts',
      kind: 'add',
      range_label: 'L1-2',
      agent: {
        name: 'unattributed',
        kind: 'muted',
        initial: '?',
      },
      confidence: 'high',
      lines: [
        {
          kind: 'add',
          no: '+1',
          text: 'export const a = 1;',
        },
        {
          kind: 'add',
          no: '+2',
          text: 'export const b = 2;',
        },
      ],
    },
  },
  session: null,
  reviewers: [],
};
