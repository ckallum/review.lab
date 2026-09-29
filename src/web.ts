import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the bundled revision page. Resolved relative to this module, like
 * `defaultMigrationsDir`, so it holds from the source tree and after
 * `bun install -g reviewdev` (both keep `<root>/src/web.ts` beside `<root>/web/`).
 * `fileURLToPath` rather than `import.meta.dir`: vitest's transform doesn't surface the latter.
 */
export function defaultWebIndexPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
}

/**
 * Read the revision page once, at serve start.
 * @throws Error naming the path when the file is missing, so `serve` exits 1
 *   instead of answering every revision URL with a blank page.
 */
export function loadIndexHtml(path: string = defaultWebIndexPath()): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`reviewdev serve: web page not found at ${path}; reinstall reviewdev`, {
      cause,
    });
  }
}
