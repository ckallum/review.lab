import type { Io } from './cli.ts';

/**
 * Structured logging: one JSON object per line to stdout — greppable, no deps.
 * The envelope (`{ ts, event, ...fields }`) is defined once here so every
 * command emits the same shape and the `ts` key / event taxonomy can't drift
 * between `serve` and `publish`.
 */
export function logLine(io: Io, event: string, fields: Record<string, unknown> = {}): void {
  io.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}
