import type { CommandHandler } from '../cli.ts';

export const runServe: CommandHandler = async (_args, io) => {
  io.stderr.write('reviewdev serve: not yet implemented (lands in T1.3)\n');
  return 0;
};
