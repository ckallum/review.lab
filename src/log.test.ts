import { describe, it, expect } from 'vitest';
import type { Io } from './cli.ts';
import { logLine } from './log.ts';

function captureIo(): Io & { out: () => string } {
  let buf = '';
  return {
    stdout: { write: (c: string) => (buf += c) },
    stderr: { write: () => undefined },
    out: () => buf,
  };
}

describe('logLine', () => {
  it('writes one JSON line with ts, event, and fields', () => {
    const io = captureIo();
    logLine(io, 'serve.listening', { port: 7891 });
    const text = io.out();
    expect(text.endsWith('\n')).toBe(true);
    const obj = JSON.parse(text.trim());
    expect(obj.event).toBe('serve.listening');
    expect(obj.port).toBe(7891);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('works with no fields', () => {
    const io = captureIo();
    logLine(io, 'serve.shutdown');
    expect(JSON.parse(io.out().trim()).event).toBe('serve.shutdown');
  });
});
