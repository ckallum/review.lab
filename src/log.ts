import type { Stream } from './cli.ts';

/**
 * Structured logging: one JSON object per line to the given stream — greppable,
 * no deps. The envelope (`{ ts, event, ...fields }`) is defined once here so
 * every command emits the same shape and the `ts` key / event taxonomy can't
 * drift between `serve` and `publish`.
 *
 * The destination is the caller's choice, not hardcoded to stdout: `serve`'s
 * stdout *is* its log stream, but `publish` is a one-shot whose stdout carries
 * the review URL (its single result), so publish routes diagnostics to stderr
 * to keep stdout a clean, single-value result (#20).
 */
export function logLine(out: Stream, event: string, fields: Record<string, unknown> = {}): void {
  out.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}
