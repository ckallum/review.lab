import type { CommandHandler } from '../cli.ts';

export const runPublish: CommandHandler = async (_args, io) => {
  io.stderr.write('reviewdev publish: not yet implemented (lands in T1.4)\n');
  return 0;
};
