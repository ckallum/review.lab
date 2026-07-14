import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The demo import (T1.7) is a static asset, not a module — assert its T1.7
// contract by scanning the delivered markup: Concept 01 only, no numeric
// confidence, and a render path that is a pure function of revision data.
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');

describe('web/index.html — T1.7 demo import', () => {
  it('keeps Concept 01 only — tab nav and Concepts 02–06 are stripped', () => {
    expect(html).not.toContain('top-tabs');
    expect(html).not.toContain('role="tablist"');
    for (const n of ['02', '03', '04', '05', '06']) {
      expect(html).not.toContain('panel-' + n);
      expect(html).not.toContain('Concept ' + n);
    }
    expect(html).toContain('id="panel-01"');
  });

  it('replaces numeric confidence with word bands', () => {
    // No `conf 0.94`-style numeric confidence survives anywhere.
    expect(html).not.toMatch(/conf 0\.\d/);
    expect(html).not.toContain('confidence 0.');
    // The three bands and their red/amber/green rules are present (FR-P0.5).
    expect(html).toContain('.conf.high');
    expect(html).toContain('.conf.medium');
    expect(html).toContain('.conf.low');
    expect(html).toContain('function confidenceBand');
  });

  it('maps confidence values to the correct band per FR-P0.5 thresholds', () => {
    // Evaluate the page's own confidenceBand so a threshold drift in the HTML
    // (not a copy of it here) is what breaks this test. Extract by brace-counting
    // from the declaration to its matching close, so a future nested block in the
    // function body can't truncate the source and throw a confusing syntax error.
    const start = html.indexOf('function confidenceBand');
    expect(start, 'confidenceBand not found in web/index.html').toBeGreaterThan(-1);
    const open = html.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const band = new Function(`${html.slice(start, end + 1)}; return confidenceBand;`)() as (
      c: number | string | null | undefined,
    ) => string;
    // Numeric inputs cross each threshold (FR-P0.5): green/amber/red.
    expect(band(0.94)).toBe('high');
    expect(band(0.71)).toBe('medium');
    expect(band(0.49)).toBe('low');
    // Valid string bands pass through; the week-1 stub sends "high" for every hunk.
    expect(band('high')).toBe('high');
    // Unknown/missing confidence falls to the safe (low) end, never "high".
    expect(band('bogus')).toBe('low');
    expect(band('')).toBe('low');
    expect(band(null)).toBe('low');
    expect(band(undefined)).toBe('low');
  });

  it('is data-driven — renders from a revision object, not hardcoded content', () => {
    expect(html).toContain('function renderRevision');
    expect(html).toContain('window.__REVISION__');
    // Falls back to the live route the demo view will hydrate from (T1.9).
    expect(html).toContain('/api/pr/');
    expect(html).toContain('const DEMO_REVISION');
  });

  it('renders the FR-P0.6 surface from data — chapters, spans, hunks, attribution', () => {
    expect(html).toContain('toc-item'); // chapter sidebar
    expect(html).toContain('chapter-spans'); // file-pill spans
    expect(html).toContain('hunk-head'); // hunks
    expect(html).toContain('author'); // attribution chips
    expect(html).toContain('skeleton'); // skeleton before render
  });
});
