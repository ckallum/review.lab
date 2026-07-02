import { describe, it, expect } from 'vitest';
import type { Stream } from './cli.ts';
import { logLine } from './log.ts';

function captureStream(): Stream & { out: () => string } {
  let buf = '';
  return { write: (c: string) => (buf += c), out: () => buf };
}

describe('logLine', () => {
  it('writes one JSON line with ts, event, and fields', () => {
    const out = captureStream();
    logLine(out, 'serve.listening', { port: 7891 });
    const text = out.out();
    expect(text.endsWith('\n')).toBe(true);
    const obj = JSON.parse(text.trim());
    expect(obj.event).toBe('serve.listening');
    expect(obj.port).toBe(7891);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('works with no fields', () => {
    const out = captureStream();
    logLine(out, 'serve.shutdown');
    expect(JSON.parse(out.out().trim()).event).toBe('serve.shutdown');
  });

  it('writes to whichever stream the caller passes (publish routes to stderr)', () => {
    const stdout = captureStream();
    const stderr = captureStream();
    logLine(stderr, 'publish.resolved', { hunk_count: 3 });
    expect(stdout.out()).toBe('');
    expect(JSON.parse(stderr.out().trim())).toMatchObject({
      event: 'publish.resolved',
      hunk_count: 3,
    });
  });

  it('reserves ts and event — caller fields cannot clobber the envelope', () => {
    const out = captureStream();
    logLine(out, 'real.event', { event: 'spoofed', ts: 'spoofed', extra: 1 });
    const obj = JSON.parse(out.out().trim());
    expect(obj.event).toBe('real.event');
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(obj.extra).toBe(1);
  });
});
