import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HTMLInputElement } from 'happy-dom';
import { GOLDEN_VIEW } from './revision-view.fixture.ts';
import { closePages, json, loadPage, text, type FetchImpl, type Page } from './web-harness.ts';
import { loadIndexHtml } from './web.ts';

// DOM contract for web/index.html (T1.9): data-source selection, the error and
// empty states, and chapter switching, driven through the page's real fetch path.

const ORIGIN = 'http://127.0.0.1:7891';
const ROUTE = ORIGIN + '/pr/1/rev/1';
const DEMO_TITLE = 'Add semantic search to support inbox';
const XSS = '<img src=x onerror=alert(1)>';

type Json = Record<string, any>;
const golden = (): Json => structuredClone(GOLDEN_VIEW) as Json;

const hung: FetchImpl = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

function sequence(...impls: FetchImpl[]): FetchImpl {
  return (url, init) => impls.shift()!(url, init);
}

async function loaded(view: Json = golden(), url = ROUTE): Promise<Page> {
  const p = loadPage(url, json(view));
  await p.settle();
  expect(p.$('.state-error'), 'page rendered an error state').toBeNull();
  return p;
}

const headText = (p: Page) => p.$('.main h3.head')?.textContent;
const currentToc = (p: Page) => p.$('.toc-item[aria-current="page"]');
const panelBusy = (p: Page) => p.$('#panel-01')!.getAttribute('aria-busy');

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closePages();
});

describe('source selection', () => {
  it.each(['file:///x/index.html', ORIGIN + '/index.html'])(
    '%s renders the demo without fetching',
    (url) => {
      const p = loadPage(url);
      expect(p.$('.pr-head h2')!.textContent).toContain(DEMO_TITLE);
      expect(p.calls).toHaveLength(0);
    },
  );

  it.each(['/pr/1', '/pr/1/rev/2/diff', '/pr/1/rev/2/'])(
    'http path %s shows "Not a revision address", never the demo',
    (path) => {
      const p = loadPage(ORIGIN + path);
      expect(p.$('#stateTitle')!.textContent).toBe('Not a revision address');
      expect(p.$('[role="alert"]')).not.toBeNull();
      expect(p.document.title).toBe('Not a revision address — review.dev');
      expect(p.calls).toHaveLength(0);
      expect(p.document.body.textContent).not.toContain(DEMO_TITLE);
    },
  );

  it('a revision route fetches its API path once and stays busy until the response lands', async () => {
    let answer!: (r: Response) => void;
    const p = loadPage(
      ORIGIN + '/pr/1/rev/2',
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    await p.settle();
    expect(p.calls.map((c) => c.url)).toEqual(['/api/pr/1/rev/2']);
    const headers = new Headers(p.calls[0]!.init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(panelBusy(p)).toBe('true');

    answer(new Response(JSON.stringify(golden())));
    await p.settle();
    expect(panelBusy(p)).toBe('false');
    expect(p.calls).toHaveLength(1);
  });
});

describe('error states', () => {
  it('400 is "Not a revision address" with the server message and no retry', async () => {
    const p = loadPage(ROUTE, json({ error: 'pull id must be a positive integer' }, 400));
    await p.settle();
    expect(p.$('#stateTitle')!.textContent).toBe('Not a revision address');
    expect(p.$('.state-detail')!.textContent).toContain('Server said');
    expect(p.$('.state-detail code')!.textContent).toBe('pull id must be a positive integer');
    expect(p.$('#retryBtn')).toBeNull();
  });

  it('404 with a latest revision links to /pr/:id and offers no retry', async () => {
    const message = 'revision 9 not found for pull 1';
    const p = loadPage(
      ORIGIN + '/pr/1/rev/9',
      json({ error: message, latest_revision_number: 2 }, 404),
    );
    await p.settle();
    expect(p.$('.state-error .pre-label')!.textContent).toBe('Pull 1 · revision 9');
    expect(p.$('#stateTitle')!.textContent).toBe('Revision not found');
    // The lede already quotes the server message, so there is no "Server said" line.
    expect(p.$('.state-error .lede')!.textContent).toBe(message + '.');
    expect(p.$('#panel-01')!.textContent.split(message)).toHaveLength(2);
    expect(p.$('.state-detail')).toBeNull();
    const link = p.$('.state-actions a[href="/pr/1"]');
    expect(link!.textContent).toBe('Open the latest revision');
    expect(p.$('#retryBtn')).toBeNull();
  });

  it('404 with latest_revision_number null has no latest link', async () => {
    const p = loadPage(
      ROUTE,
      json({ error: 'pull 1 not found', latest_revision_number: null }, 404),
    );
    await p.settle();
    expect(p.$('#stateTitle')!.textContent).toBe('Revision not found');
    expect(p.$('.state-detail')).toBeNull();
    expect(p.$('.state-actions a')).toBeNull();
    expect(p.$('#retryBtn')).toBeNull();
  });

  it('500 names the status and shows the server message as text, not markup', async () => {
    const p = loadPage(ROUTE, json({ error: XSS }, 500));
    await p.settle();
    expect(p.$('.state-error .lede')!.textContent).toContain('HTTP 500');
    expect(p.$('.state-detail img')).toBeNull();
    expect(p.$('.state-detail code')!.textContent).toBe(XSS);
    expect(p.$('#retryBtn')).not.toBeNull();
  });

  it('500 with a non-JSON body shows no server message and does not throw', async () => {
    const p = loadPage(ROUTE, text('<html>proxy error</html>', 500));
    await p.settle();
    expect(p.$('#stateTitle')!.textContent).toBe("Couldn't load this revision");
    expect(p.$('.state-detail')).toBeNull();
  });

  it('a rejected fetch shows the network copy with a retry', async () => {
    const p = loadPage(ROUTE, async () => {
      throw new TypeError('Failed to fetch');
    });
    await p.settle();
    expect(p.$('#stateTitle')!.textContent).toBe("Couldn't reach the review.dev server");
    expect(p.$('#retryBtn')).not.toBeNull();
  });

  it('a hung fetch times out at exactly 8000 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = loadPage(ROUTE, hung);
    await vi.advanceTimersByTimeAsync(7999);
    expect(panelBusy(p)).toBe('true');
    expect(p.$('.state-error')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.$('#stateTitle')!.textContent).toBe("The review.dev server didn't answer");
    expect(p.$('#retryBtn')).not.toBeNull();
  });

  it('the 8000 ms budget also covers reading a body that never finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = loadPage(ROUTE, async (_url, init) => {
      const body = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener('abort', () =>
            c.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body);
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(panelBusy(p)).toBe('true');
    await vi.advanceTimersByTimeAsync(1);
    expect(p.$('#stateTitle')!.textContent).toBe("The review.dev server didn't answer");
  });

  const edited = (change: (v: Json) => unknown): string => {
    const v = golden();
    change(v);
    return JSON.stringify(v);
  };
  // Body-parse failures first, then validateRevision's checks in order.
  it.each([
    ['empty body', '', 'empty response'],
    ['whitespace body', ' \n', 'empty response'],
    ['non-JSON body', '{nope', 'not JSON'],
    ['null', 'null', 'not a JSON object'],
    ['an array', '[]', 'not a JSON object'],
    ['a null pull.title', edited((v) => (v.pull.title = null)), 'pull needs a string title'],
    ['chapters as an object', edited((v) => (v.chapters = {})), 'chapters is not an array'],
    ['hunks as an array', edited((v) => (v.hunks = [])), 'hunks is not an object'],
    [
      'a hunk without lines',
      edited((v) => delete v.hunks[v.chapters[0].hunk_ids[0]].lines),
      'needs a string file_path and a lines array',
    ],
    [
      'a null hunk line',
      edited((v) => (v.hunks[v.chapters[0].hunk_ids[0]].lines = [null])),
      'has a line that is not an object',
    ],
    ['a chapter without an id', edited((v) => delete v.chapters[0].id), 'no string or number id'],
    [
      'hunk_ids as a string',
      edited((v) => (v.chapters[0].hunk_ids = 'zzz')),
      'hunk_ids that is not an array',
    ],
    [
      'a dangling hunk id',
      edited((v) => (v.chapters[0].hunk_ids = ['zzz'])),
      'chapter § 01 references hunk zzz',
    ],
    [
      'an inherited hunk id',
      edited((v) => (v.chapters[0].hunk_ids = ['constructor'])),
      'references hunk constructor',
    ],
  ])('200 with %s is a malformed revision offering Reload', async (_name, body, reason) => {
    const p = loadPage(ROUTE, text(body));
    await p.settle();
    expect(p.$('#stateTitle')!.textContent).toBe("This revision couldn't be displayed");
    expect(p.$('.state-error .lede')!.textContent).toContain(reason);
    expect(p.$('#retryBtn')).toBeNull();
    const reload = vi.spyOn(p.window.location, 'reload').mockImplementation(() => {});
    p.$('#reloadBtn')!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['spans as a string (throws in render)', edited((v) => (v.chapters[0].spans = 'x'))],
    [
      'a hunk id with no string form (throws in validation)',
      edited((v) => (v.chapters[0].hunk_ids = [{ toString: 1 }])),
    ],
  ])('200 with %s is a malformed revision, not a stuck skeleton', async (_name, body) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const p = loadPage(ROUTE, text(body));
      await p.settle();
      expect(p.$('[role="alert"]')).not.toBeNull();
      expect(p.$('#stateTitle')!.textContent).toBe("This revision couldn't be displayed");
      expect(p.$('.state-error .lede')!.textContent).toContain('the page could not render it');
      expect(p.$('#reloadBtn')).not.toBeNull();
      expect(panelBusy(p)).not.toBe('true');
      expect(p.errors.length).toBeGreaterThanOrEqual(1);
      expect(p.document.title).toBe("This revision couldn't be displayed — review.dev");
      // The error screen holds no revision, so j is not consumed.
      expect(p.press('j').defaultPrevented).toBe(false);
      await p.settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it.each<[string, FetchImpl, boolean]>([
    ['bad-url (400)', json({ error: 'pull id must be a positive integer' }, 400), false],
    [
      'not-found (404)',
      json({ error: 'pull 1 not found', latest_revision_number: null }, 404),
      false,
    ],
    ['http (500)', json({ error: 'internal error reading revision' }, 500), false],
    [
      'network',
      async () => {
        throw new TypeError('Failed to fetch');
      },
      false,
    ],
    ['timeout', hung, true],
    ['malformed', text('{nope'), false],
  ])(
    '%s: role=alert, no demo, a console.error line, titled for review.dev',
    async (_k, impl, timers) => {
      if (timers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = loadPage(ROUTE, impl);
      if (timers) await vi.advanceTimersByTimeAsync(8000);
      else await p.settle();
      expect(p.$('[role="alert"]')).not.toBeNull();
      expect(p.document.body.textContent).not.toContain(DEMO_TITLE);
      expect(p.errors.length).toBeGreaterThanOrEqual(1);
      expect(p.document.title.endsWith(' — review.dev')).toBe(true);
    },
  );
});

describe('retry', () => {
  it('shows the skeleton at once, then renders and focuses the current chapter', async () => {
    // Chapter 2 is the active one, so focus must follow aria-current, not the first item.
    const view = golden();
    view.chapters[0].active = false;
    view.chapters[1].active = true;
    const p = loadPage(ROUTE, sequence(json({ error: 'boom' }, 500), json(view)));
    await p.settle();
    p.$('#retryBtn')!.click();
    expect(p.$('#skeleton')).not.toBeNull();
    expect(panelBusy(p)).toBe('true');
    expect(p.$('#retryBtn')).toBeNull();

    await p.settle();
    expect(p.calls).toHaveLength(2);
    expect(p.$$('.toc-item')).toHaveLength(3);
    expect(currentToc(p)!.getAttribute('data-toc')).toBe('2');
    expect(p.document.activeElement).toBe(currentToc(p));
  });

  it('a retry that fails again focuses Try again', async () => {
    const p = loadPage(ROUTE, sequence(json({ error: 'a' }, 500), json({ error: 'b' }, 500)));
    await p.settle();
    p.$('#retryBtn')!.click();
    await p.settle();
    expect(p.calls).toHaveLength(2);
    expect(p.document.activeElement!.id).toBe('retryBtn');
  });
});

describe('loaded revision', () => {
  it('renders the golden view with no placeholder leaks', async () => {
    const p = await loaded();
    const items = p.$$('.toc-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.getAttribute('aria-current')).toBe('page');
    expect(headText(p)).toBe('lib');
    expect(p.$$('.hunk')).toHaveLength(1);
    expect(p.$('.toc-frac')).toBeNull();
    const panelText = p.$('#panel-01')!.textContent;
    for (const leak of ['undefined', 'null', 'NaN', '[object Object]']) {
      expect(panelText).not.toContain(leak);
    }
    expect(p.$('.rail-empty')).not.toBeNull();
    expect(p.$('.pr-meta')!.textContent).toContain('Written by');
    expect(p.$$('.pr-meta .author-chip').map((e) => e.textContent)).toEqual(['?unattributed']);
    expect(p.$<HTMLInputElement>('#askAuthor')!.placeholder).not.toContain('pgvector');
    expect(p.document.title).toBe('feat/readme — review.dev');
  });

  it('renders the "No newline" marker as a meta line and an unnumbered removal as "-"', async () => {
    const p = await loaded();
    p.$$('.toc-item')[2]!.click();
    expect(p.$('.hunk .path')!.textContent).toContain('README.md');
    const meta = p.$$('.hunk-body .line.meta');
    expect(meta).toHaveLength(1);
    expect(meta[0]!.textContent).toBe('No newline at end of file');
    expect(p.$('.hunk-body .line.del .ln')!.textContent).toBe('-');
  });

  it('escapes line text and whitelists line kinds', async () => {
    const view = golden();
    const firstHunk = view.chapters[0].hunk_ids[0];
    const raw = '</script>' + XSS;
    view.hunks[firstHunk].lines = [
      { kind: 'add', no: '+1', text: raw },
      { kind: 'evil', no: '2', text: 'x' },
    ];
    const p = await loaded(view);
    expect(p.$('.hunk-body img')).toBeNull();
    const lines = p.$$('.hunk-body .line');
    expect(lines[0]!.textContent).toBe('+1' + raw);
    expect(lines[1]!.className).toBe('line ctx');
  });
});

describe('pinned revision indicator', () => {
  it('an older revision says "Revision 1 of 2" and links to the latest', async () => {
    const p = await loaded({ ...golden(), revision_number: 1, latest_revision_number: 2 });
    expect(p.$('.pr-meta')!.textContent).toContain('Revision 1 of 2');
    expect(p.$('.pr-meta a[href="/pr/1"]')!.textContent).toBe('Go to latest');
  });

  it('the latest revision says "Revision 2 of 2" with no link', async () => {
    const p = await loaded(
      { ...golden(), revision_number: 2, latest_revision_number: 2 },
      ORIGIN + '/pr/1/rev/2',
    );
    expect(p.$('.pr-meta')!.textContent).toContain('Revision 2 of 2');
    expect(p.$('.pr-meta a')).toBeNull();
  });
});

describe('empty revision (#36)', () => {
  it('explains an empty publish instead of rendering a blank chapter', async () => {
    const view = golden();
    Object.assign(view.pull, { title: 'feat/x', branch: 'feat/x', base: 'main' });
    Object.assign(view, {
      chapters: [],
      hunks: {},
      authors: [],
      stats: { additions: 0, deletions: 0, files: 0 },
    });
    const p = await loaded(view);
    expect(p.$('#stateTitle')!.textContent).toBe('Nothing to review in this revision');
    expect(p.$('.state-empty')!.textContent).toMatch(/rename.*binary/);
    expect(p.$('.state-empty code')!.textContent).toBe('main');
    expect(p.$('.toc-empty')!.textContent).toBe('No chapters');
    expect(p.$('.pr-meta .stats')!.textContent).toBe('No line-level changes');
    expect(p.$('.pr-meta')!.textContent).not.toContain('Written by');
    expect(p.document.title).toBe('feat/x — review.dev');

    const before = p.$('#panel-01')!.innerHTML;
    expect(() => p.press('j')).not.toThrow();
    expect(p.$('#panel-01')!.innerHTML).toBe(before);
  });
});

describe('chapter switching', () => {
  it('clicking a TOC item renders that chapter and keeps focus on the button', async () => {
    const p = await loaded();
    const btn = p.$$('.toc-item')[1]!;
    btn.focus();
    btn.click();
    expect(currentToc(p)).toBe(btn);
    expect(p.$$('.toc-item[aria-current]')).toHaveLength(1);
    expect(headText(p)).toBe('src');
    expect(p.$$('.hunk .path').map((e) => e.textContent)).toEqual(['src/a.ts · L1-2']);
    expect(p.document.activeElement).toBe(btn);
  });

  it('a chapter that throws in render shows the malformed screen, not a half-switched panel', async () => {
    const view = golden();
    view.chapters[1].spans = 'x';
    const p = await loaded(view);
    p.$$('.toc-item')[1]!.click();
    expect(p.$('[role="alert"]')).not.toBeNull();
    expect(p.$('.state-error .pre-label')!.textContent).toBe('Pull 1 · revision 1');
    expect(p.$('.state-error .lede')!.textContent).toContain('could not render chapter § 02');
    expect(p.$('#reloadBtn')).not.toBeNull();
    expect(p.errors.length).toBeGreaterThanOrEqual(1);
    expect(p.press('j').defaultPrevented).toBe(false);
  });

  it('k on the first chapter does nothing; j clamps at the last chapter', async () => {
    const p = await loaded();
    p.press('k');
    expect(headText(p)).toBe('lib');
    expect(currentToc(p)!.getAttribute('data-toc')).toBe('1');

    p.press('j');
    p.press('j');
    p.press('j');
    expect(headText(p)).toBe('(root)');
    expect(currentToc(p)!.getAttribute('data-toc')).toBe('3');
    await vi.waitFor(() =>
      expect(p.$('#liveStatus')!.textContent).toBe('Already at the last chapter'),
    );
  });

  it('numbers chapters by position, not by their stored order', async () => {
    const view = golden();
    view.chapters.forEach((c: Json, i: number) => (c.order = [1, 5, 9][i]));
    const p = await loaded(view);
    expect(p.$$('.toc-n').map((e) => e.textContent)).toEqual(['1', '2', '3']);
    p.press('j');
    await vi.waitFor(() => expect(p.$('#liveStatus')!.textContent).toBe('Chapter 2 of 3: src'));
  });

  it('j/k do nothing behind the open help dialog', async () => {
    const p = await loaded();
    p.$('#helpTrigger')!.click();
    expect(p.$('#helpDialog')!.classList.contains('open')).toBe(true);
    expect(p.press('j').defaultPrevented).toBe(false);
    expect(headText(p)).toBe('lib');
  });

  it('j from a focused TOC item moves focus to the new current item', async () => {
    const p = await loaded();
    p.$$('.toc-item')[0]!.focus();
    p.press('j');
    expect(p.document.activeElement).toBe(currentToc(p));
    expect(currentToc(p)!.getAttribute('data-toc')).toBe('2');
  });

  it('j with focus on body leaves focus on body', async () => {
    const p = await loaded();
    expect(p.document.activeElement).toBe(p.document.body);
    p.press('j');
    expect(headText(p)).toBe('src');
    expect(p.document.activeElement).toBe(p.document.body);
  });

  it('modified keys and keys typed into the ask field are left alone', async () => {
    const p = await loaded();
    p.press('j');
    expect(headText(p)).toBe('src');
    const cases = [
      p.press('c', { metaKey: true }),
      p.press('r', { ctrlKey: true }),
      p.press('j', { altKey: true }),
      p.press('k', {}, p.$('#askAuthor')!),
    ];
    for (const ev of cases) expect(ev.defaultPrevented).toBe(false);
    expect(headText(p)).toBe('src');
    expect(currentToc(p)!.getAttribute('data-toc')).toBe('2');
  });

  it('recompose and ask handlers are wired on the newly rendered chapter', async () => {
    const p = await loaded();
    p.press('j');
    expect(headText(p)).toBe('src');

    p.$('#recomposeBtn')!.click();
    expect(p.$('#recomposeBtn')!.textContent).toBe('Recomposing…');

    const input = p.$<HTMLInputElement>('#askAuthor')!;
    input.value = 'why?';
    p.press('Enter', { metaKey: true }, input);
    expect(p.$('#askHint')!.textContent).toContain('Asked the author');
  });

  it('re-selecting the active chapter keeps the ask draft', async () => {
    const p = await loaded();
    p.$<HTMLInputElement>('#askAuthor')!.value = 'draft';
    p.$$('.toc-item')[0]!.click();
    expect(p.$<HTMLInputElement>('#askAuthor')!.value).toBe('draft');
  });

  it('scrolls the new chapter into view only when its top is above the viewport', async () => {
    const p = await loaded();
    const proto = p.window.Element.prototype;
    const rect = vi.spyOn(proto, 'getBoundingClientRect');
    const scroll = vi.spyOn(proto, 'scrollIntoView').mockImplementation(() => {});

    rect.mockReturnValue({ top: -40 } as ReturnType<typeof proto.getBoundingClientRect>);
    p.$$('.toc-item')[1]!.click();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });

    rect.mockReturnValue({ top: 10 } as ReturnType<typeof proto.getBoundingClientRect>);
    p.$$('.toc-item')[2]!.click();
    expect(headText(p)).toBe('(root)');
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe('demo contract', () => {
  function demoRevision(): Json {
    const html = loadIndexHtml();
    const decl = 'const DEMO_REVISION = ';
    const start = html.indexOf(decl) + decl.length;
    expect(start, 'DEMO_REVISION not found').toBeGreaterThan(decl.length - 1);
    let depth = 0;
    let end = start;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    return new Function(`return ${html.slice(start, end + 1)};`)() as Json;
  }

  it('DEMO_REVISION served as the API body passes validation and renders like file://', async () => {
    const live = await loaded(demoRevision());
    const standalone = loadPage('file:///x/index.html');
    expect(live.$('#panel-01')!.innerHTML).toBe(standalone.$('#panel-01')!.innerHTML);
  });
});
