import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultWebIndexPath, loadIndexHtml } from './web.ts';

describe('defaultWebIndexPath', () => {
  it('resolves to the bundled revision page beside src/, independent of cwd', () => {
    const cwd = process.cwd();
    let path: string;
    process.chdir(tmpdir());
    try {
      path = defaultWebIndexPath();
    } finally {
      process.chdir(cwd);
    }
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(fileURLToPath(new URL('../web/index.html', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('id="panel-01"');
  });
});

describe('loadIndexHtml', () => {
  it('reads the bundled page by default', () => {
    expect(loadIndexHtml()).toBe(readFileSync(defaultWebIndexPath(), 'utf8'));
  });

  it('throws a reinstall error naming the missing path, with the fs error as cause', () => {
    const missing = '/nonexistent/index.html';
    let err: unknown;
    try {
      loadIndexHtml(missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const { message, cause } = err as Error;
    expect(message).toContain(missing);
    expect(message).toContain('reinstall');
    expect(cause).toMatchObject({ code: 'ENOENT' });
  });
});
