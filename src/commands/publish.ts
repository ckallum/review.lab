import type { CommandHandler } from '../cli.ts';

// Stub. Real implementation lands in T1.4.
// Returns non-zero so callers chaining `reviewdev publish && next` don't
// silently proceed past a no-op command.
export const runPublish: CommandHandler = async (_args, io) => {
  io.stderr.write('reviewdev publish: not yet implemented (lands in T1.4)\n');
  return 1;
};
