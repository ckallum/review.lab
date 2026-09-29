import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from './diff.ts';
import {
  detectBaseBranch,
  diffRange,
  makeGitRunner,
  resolveEndpoints,
  throttledFetch,
  workingTreeDirty,
  type GitRunner,
} from './git.ts';

// A fake GitRunner driven by a map from `args.join(' ')` to a response, or a
// thrown error. Records every call so tests can assert what git was asked to do.
function fakeGit(
  responses: Record<string, string | (() => string)>,
): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const git = ((args: readonly string[]) => {
    calls.push([...args]);
    const key = args.join(' ');
    const r = responses[key];
    if (r === undefined) throw new Error(`unexpected git call: ${key}`);
    return typeof r === 'function' ? r() : r;
  }) as GitRunner & { calls: string[][] };
  git.calls = calls;
  return git;
}

const throws = () => {
  throw new Error('boom');
};

describe('detectBaseBranch', () => {
  it('reads origin/HEAD and strips the origin/ prefix', () => {
    const git = fakeGit({ 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main' });
    expect(detectBaseBranch(git, () => null)).toBe('main');
  });

  it('falls back to the gh PR base when origin/HEAD is unset', () => {
    const git = fakeGit({ 'symbolic-ref --short refs/remotes/origin/HEAD': throws });
    expect(detectBaseBranch(git, () => 'develop')).toBe('develop');
  });

  it('prefers master over main when only master has a remote ref', () => {
    const git = fakeGit({
      'symbolic-ref --short refs/remotes/origin/HEAD': throws,
      'rev-parse --verify --quiet refs/remotes/origin/main': throws,
      'rev-parse --verify --quiet refs/remotes/origin/master': '',
    });
    expect(detectBaseBranch(git, () => null)).toBe('master');
  });

  it('defaults to main when nothing else resolves', () => {
    const git = fakeGit({
      'symbolic-ref --short refs/remotes/origin/HEAD': throws,
      'rev-parse --verify --quiet refs/remotes/origin/main': throws,
      'rev-parse --verify --quiet refs/remotes/origin/master': throws,
    });
    expect(detectBaseBranch(git, () => null)).toBe('main');
  });
});

describe('throttledFetch', () => {
  let dir: string;
  let marker: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewdev-fetch-'));
    marker = join(dir, 'last-fetch');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fetches and writes the marker on first publish (no marker yet)', () => {
    const git = fakeGit({ 'fetch origin main': '' });
    const res = throttledFetch({ git, base: 'main', markerPath: marker, now: 1_000_000 });
    expect(res).toEqual({ fetched: true });
    expect(existsSync(marker)).toBe(true);
    expect(git.calls).toContainEqual(['fetch', 'origin', 'main']);
  });

  it('skips the fetch when the marker is younger than the throttle window', () => {
    writeFileSync(marker, '');
    const now = 5_000_000;
    utimesSync(marker, now / 1000, now / 1000); // mtime == now
    const git = fakeGit({}); // any git call would throw "unexpected"
    const res = throttledFetch({ git, base: 'main', markerPath: marker, now });
    expect(res).toEqual({ fetched: false, reason: 'throttled' });
    expect(git.calls).toEqual([]);
  });

  it('fetches again once the marker is older than the throttle window', () => {
    writeFileSync(marker, '');
    const old = 1_000_000;
    utimesSync(marker, old / 1000, old / 1000);
    const git = fakeGit({ 'fetch origin main': '' });
    const res = throttledFetch({
      git,
      base: 'main',
      markerPath: marker,
      now: old + 61_000,
    });
    expect(res.fetched).toBe(true);
    // marker mtime advanced to the new `now`
    expect(statSync(marker).mtimeMs).toBeCloseTo(old + 61_000, -2);
  });

  it('treats a fetch failure as non-fatal and reports the reason', () => {
    const git = fakeGit({ 'fetch origin main': throws });
    const res = throttledFetch({ git, base: 'main', markerPath: marker, now: 1_000_000 });
    expect(res.fetched).toBe(false);
    if (res.fetched) throw new Error('unreachable: fetch was expected to fail');
    expect(res.reason).toMatch(/boom/);
    expect(existsSync(marker)).toBe(false); // failed fetch must not stamp the throttle
  });
});

describe('endpoint + diff helpers', () => {
  it('diffs merge-base..HEAD, not origin/base..HEAD', () => {
    const git = fakeGit({
      'rev-parse HEAD': 'headsha',
      'merge-base HEAD origin/main': 'basesha',
    });
    expect(resolveEndpoints(git, 'main')).toEqual({ headSha: 'headsha', baseSha: 'basesha' });
  });

  it('passes the base sha into git diff and asks for untrimmed output', () => {
    const args = [
      '-c diff.suppressBlankEmpty=false -c core.quotePath=true -c diff.relative=false diff',
      '--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/',
      '--unified=3 --inter-hunk-context=0 --diff-algorithm=myers --indent-heuristic',
      '--find-renames basesha..HEAD',
    ].join(' ');
    const seen: unknown[] = [];
    const git: GitRunner = (a, opts) => {
      seen.push(opts);
      return fakeGit({ [args]: 'THE DIFF' })(a);
    };
    expect(diffRange(git, 'basesha')).toBe('THE DIFF');
    expect(seen).toEqual([{ raw: true }]);
  });

  describe('against a real repository', () => {
    let dir: string;
    const g = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    function commitFile(path: string, content: string, message: string): void {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
      g('add', '.');
      g('commit', '-q', '-m', message);
    }

    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'reviewdev-git-diff-')));
      g('init', '-q');
      g('config', 'user.email', 'test@example.com');
      g('config', 'user.name', 'Test');
      g('config', 'commit.gpgsign', 'false');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('pins the patch text against user config and keeps trailing whitespace', () => {
      // A top-level dir named `a/` tells a real prefix apart from a missing one.
      commitFile('a/f.txt', 'one\n\ntwo\nthree\nfour\n\n', 'base');
      const base = g('rev-parse', 'HEAD').trim();
      commitFile('a/f.txt', 'one\n\ntwo\nTHREE  \nfour\n\n', 'change');
      for (const [key, value] of [
        ['diff.suppressBlankEmpty', 'true'],
        ['color.ui', 'always'],
        ['diff.noprefix', 'true'],
        ['diff.context', '1'],
      ]) {
        g('config', key!, value!);
      }

      const hunks = parseDiff(diffRange(makeGitRunner(dir), base));
      expect(hunks).toHaveLength(1);
      expect(hunks[0]!.filePath).toBe('a/f.txt');
      // Three context lines each side; the blank lines, including the final one, and
      // the trailing spaces all survive, so ids and line numbers match the file.
      expect(hunks[0]!.content).toBe(' one\n \n two\n-three\n+THREE  \n four\n ');
    });

    it("reads a diff larger than execFileSync's 1 MiB default buffer", () => {
      commitFile('seed.txt', 'seed\n', 'base');
      const base = g('rev-parse', 'HEAD').trim();
      commitFile('big.lock', 'x'.repeat(63).concat('\n').repeat(40_000), 'big');
      const hunks = parseDiff(diffRange(makeGitRunner(dir), base));
      expect(hunks).toHaveLength(1);
      expect(hunks[0]!.content.length).toBeGreaterThan(2 * 1024 * 1024);
    });
  });

  it('reports a dirty working tree from porcelain status', () => {
    expect(workingTreeDirty(fakeGit({ 'status --porcelain': ' M src/a.ts' }))).toBe(true);
    expect(workingTreeDirty(fakeGit({ 'status --porcelain': '' }))).toBe(false);
  });
});
