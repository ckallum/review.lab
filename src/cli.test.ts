import { describe, it, expect, vi } from 'vitest';
import { main, type CommandMap, type Io } from './cli.ts';

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

function spies(): CommandMap & {
  serve: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
} {
  return {
    serve: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
  };
}

describe('cli dispatcher', () => {
  it('prints help when invoked with no command', async () => {
    const io = captureIo();
    const code = await main([], io, spies());
    expect(code).toBe(0);
    expect(io.stdout.value).toContain('reviewdev — local PR review surface');
    expect(io.stdout.value).toContain('reviewdev serve');
    expect(io.stdout.value).toContain('reviewdev publish');
    expect(io.stderr.value).toBe('');
  });

  it('prints help for --help, -h, and help', async () => {
    for (const arg of ['help', '--help', '-h']) {
      const io = captureIo();
      const code = await main([arg], io, spies());
      expect(code).toBe(0);
      expect(io.stdout.value).toContain('reviewdev — local PR review surface');
    }
  });

  it('routes "serve" to the serve handler with remaining args + io', async () => {
    const io = captureIo();
    const commands = spies();
    const code = await main(['serve', '--cwd', '.'], io, commands);
    expect(commands.serve).toHaveBeenCalledTimes(1);
    expect(commands.serve).toHaveBeenCalledWith(['--cwd', '.'], io);
    expect(commands.publish).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('routes "publish" to the publish handler with remaining args + io', async () => {
    const io = captureIo();
    const commands = spies();
    const code = await main(['publish', '--session', 'abc'], io, commands);
    expect(commands.publish).toHaveBeenCalledTimes(1);
    expect(commands.publish).toHaveBeenCalledWith(['--session', 'abc'], io);
    expect(commands.serve).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('propagates the handler return code', async () => {
    const io = captureIo();
    const commands: CommandMap = {
      serve: async () => 1,
      publish: async () => 0,
    };
    expect(await main(['serve'], io, commands)).toBe(1);
    expect(await main(['publish'], io, commands)).toBe(0);
  });

  it('exits 2 with a usage message on an unknown command', async () => {
    const io = captureIo();
    const code = await main(['banana'], io, spies());
    expect(code).toBe(2);
    expect(io.stderr.value).toContain("unknown command 'banana'");
    expect(io.stderr.value).toContain('reviewdev serve');
  });
});

// serve and publish are both implemented as of T1.3 / T1.4 — their behaviour is
// covered in src/commands/serve.test.ts and src/commands/publish.test.ts. This
// file owns only the dispatch contract (above).
