import { describe, it, expect } from 'vitest';
import { main, type Io } from './cli.ts';

function captureIo(): Io & {
  stdout: { value: string; write: (c: string) => void };
  stderr: { value: string; write: (c: string) => void };
} {
  const stdout = {
    value: '',
    write(chunk: string) {
      this.value += chunk;
    },
  };
  const stderr = {
    value: '',
    write(chunk: string) {
      this.value += chunk;
    },
  };
  return { stdout, stderr };
}

describe('cli dispatcher', () => {
  it('prints help when invoked with no command', async () => {
    const io = captureIo();
    const code = await main([], io);
    expect(code).toBe(0);
    expect(io.stdout.value).toContain('reviewdev — local PR review surface');
    expect(io.stdout.value).toContain('reviewdev serve');
    expect(io.stdout.value).toContain('reviewdev publish');
    expect(io.stderr.value).toBe('');
  });

  it('prints help for --help, -h, and help', async () => {
    for (const arg of ['help', '--help', '-h']) {
      const io = captureIo();
      const code = await main([arg], io);
      expect(code).toBe(0);
      expect(io.stdout.value).toContain('reviewdev — local PR review surface');
    }
  });

  it('routes "serve" to the serve handler', async () => {
    const io = captureIo();
    const code = await main(['serve'], io);
    expect(code).toBe(0);
    expect(io.stderr.value).toContain('reviewdev serve');
  });

  it('routes "publish" to the publish handler', async () => {
    const io = captureIo();
    const code = await main(['publish'], io);
    expect(code).toBe(0);
    expect(io.stderr.value).toContain('reviewdev publish');
  });

  it('exits 2 with a usage message on an unknown command', async () => {
    const io = captureIo();
    const code = await main(['banana'], io);
    expect(code).toBe(2);
    expect(io.stderr.value).toContain("unknown command 'banana'");
    expect(io.stderr.value).toContain('reviewdev serve');
  });
});
