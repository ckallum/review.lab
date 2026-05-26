import type { CommandHandler } from '../cli.ts';

// Stub. Real implementation lands in T1.3.
// Returns non-zero so callers chaining `reviewdev serve && next` don't
// silently proceed past a no-op command.
export const runServe: CommandHandler = async (_args, io) => {
  io.stderr.write('reviewdev serve: not yet implemented (lands in T1.3)\n');
  return 1;
};
