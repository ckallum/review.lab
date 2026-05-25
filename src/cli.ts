#!/usr/bin/env bun
import { runServe } from './commands/serve.ts';
import { runPublish } from './commands/publish.ts';

const HELP = `reviewdev — local PR review surface

Usage:
  reviewdev serve            Start the per-repo review server
  reviewdev publish          Upload the current branch's diff as a new revision
  reviewdev help             Show this message

Each repo runs its own server, rooted at the current working directory's repo
root. See SPEC.md for the full architecture.
`;

export type Stream = { write: (chunk: string) => unknown };

export type Io = {
  stdout: Stream;
  stderr: Stream;
};

export type CommandHandler = (args: readonly string[], io: Io) => Promise<number>;

const COMMANDS: Record<string, CommandHandler> = {
  serve: runServe,
  publish: runPublish,
};

export async function main(argv: readonly string[], io: Io = process): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.stdout.write(HELP);
    return 0;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    io.stderr.write(`reviewdev: unknown command '${cmd}'\n\n${HELP}`);
    return 2;
  }

  return handler(rest, io);
}

// `import.meta.main` is Bun-only; under Vitest's node environment it is
// undefined (falsy) so this block stays inert during tests. If the test
// environment ever switches to bun, this guard needs re-evaluating.
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
