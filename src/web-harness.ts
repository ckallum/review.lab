import { Window, type Document, type Element, type IKeyboardEventInit } from 'happy-dom';
import { loadIndexHtml } from './web.ts';

/**
 * Test-only DOM harness for `web/index.html`.
 *
 * - The page's markup is parsed by happy-dom (used as a library; vitest's environment stays `node`).
 * - The page's one inline script runs in Bun's realm via `new Function`, with happy-dom's
 *   `window` / `document` / `location` passed in as the free identifiers it uses. happy-dom's own
 *   script evaluation under Bun has no JS built-ins, so it stays disabled.
 * - `setTimeout` / `clearTimeout` resolve to the global timers at call time, so
 *   `vi.useFakeTimers()` called before `loadPage` drives the page's fetch timeout.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export interface Page {
  window: Window;
  document: Document;
  /** Every fetch the page made, in order. */
  calls: FetchCall[];
  /** Each `console.error` call from the page, arguments joined with spaces. */
  errors: string[];
  $<T extends Element = HTMLElementLike>(selector: string): T | null;
  $$<T extends Element = HTMLElementLike>(selector: string): T[];
  /**
   * Dispatch a cancelable, bubbling keydown.
   * @param target defaults to the focused element, else `document.body`.
   * @returns the event, so callers can read `defaultPrevented`.
   */
  press(key: string, mods?: Partial<IKeyboardEventInit>, target?: Element): KeyboardEventLike;
  /** Resolves after pending microtasks and zero-delay timers (one macrotask turn). */
  settle(): Promise<void>;
}

type HTMLElementLike = InstanceType<Window['HTMLElement']>;
type KeyboardEventLike = InstanceType<Window['KeyboardEvent']>;

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;
const PAGE_HTML = loadIndexHtml();
const openWindows = new Set<Window>();

const noFetch: FetchImpl = async (url) => {
  throw new Error(`fetch not expected: ${url}`);
};

/**
 * Load the real page at `url` and run its script.
 * @param url sets `location`, which decides the page's data source (demo, fetch, or bad-url).
 * @param fetchImpl answers the page's fetches; the default throws.
 * @throws Error when the page does not have exactly one inline `<script>`.
 */
export function loadPage(url: string, fetchImpl: FetchImpl = noFetch): Page {
  const scripts = [...PAGE_HTML.matchAll(INLINE_SCRIPT)];
  if (scripts.length !== 1) {
    throw new Error(`web/index.html: expected 1 inline <script>, found ${scripts.length}`);
  }
  const window = new Window({
    url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  openWindows.add(window);
  const document = window.document;
  document.write(PAGE_HTML.replace(INLINE_SCRIPT, ''));

  const calls: FetchCall[] = [];
  const errors: string[] = [];
  const fetchSpy: FetchImpl = (u, init) => {
    calls.push({ url: String(u), init });
    return fetchImpl(String(u), init);
  };
  const pageConsole = {
    ...console,
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  };
  new Function(
    'window',
    'document',
    'location',
    'fetch',
    'console',
    'setTimeout',
    'clearTimeout',
    scripts[0]![1]!,
  )(
    window,
    document,
    window.location,
    fetchSpy,
    pageConsole,
    (fn: () => void, ms?: number) => setTimeout(fn, ms),
    (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  );

  return {
    window,
    document,
    calls,
    errors,
    $: <T extends Element>(s: string) => document.querySelector(s) as T | null,
    $$: <T extends Element>(s: string) => [...document.querySelectorAll(s)] as T[],
    press(key, mods = {}, target) {
      const ev = new window.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...mods,
      });
      (target ?? document.activeElement ?? document.body).dispatchEvent(ev);
      return ev;
    },
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

/** Close every window `loadPage` opened. Call from `afterEach`. */
export async function closePages(): Promise<void> {
  const windows = [...openWindows];
  openWindows.clear();
  await Promise.all(windows.map((w) => w.happyDOM.close()));
}

/** A fetch impl answering every call with `body` as JSON. */
export const json =
  (body: unknown, status = 200): FetchImpl =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch impl answering every call with `body` verbatim. */
export const text =
  (body: string, status = 200): FetchImpl =>
  async () =>
    new Response(body, { status });
