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

/**
 * Write an error to stderr and return exit code 1 — the shared failure contract
 * for command handlers. Handles non-Error throws without printing "undefined"
 * and appends a one-level `cause` chain (e.g. git's own "fatal: …" stderr that
 * `repo.ts` attaches). Used by both `serve` and `publish`.
 */
export function fail(io: Io, err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause !== undefined
      ? `: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
      : '';
  io.stderr.write(`${msg}${cause}\n`);
  return 1;
}

// Registered command names. Adding a new one here is a compile-time prompt
// to also update the HELP string and the COMMANDS map below.
export type CommandName = 'serve' | 'publish';

export type CommandMap = Record<CommandName, CommandHandler>;

export const COMMANDS: CommandMap = {
  serve: runServe,
  publish: runPublish,
};

export async function main(
  argv: readonly string[],
  io: Io = process,
  commands: CommandMap = COMMANDS,
): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.stdout.write(HELP);
    return 0;
  }

  if (!Object.hasOwn(commands, cmd)) {
    io.stderr.write(`reviewdev: unknown command '${cmd}'\n\n${HELP}`);
    return 2;
  }

  return commands[cmd as CommandName](rest, io);
}

// `import.meta.main` is Bun-only; under Vitest's node environment it is
// undefined (falsy) so this block stays inert during tests. If the test
// environment ever switches to bun, this guard needs re-evaluating.
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
