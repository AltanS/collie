// The load guard of the drift loop (2026-11-19). The daily run shares the machine with the owner's work. A lab
// run starts tmux, a scratch bridge and an agent, and a Surface read on a slow, busy machine reads wrong.
// So a tick with a high 1-minute load average does nothing: it writes one log line and exits 0, and the next
// tick tries again. Nothing is marked in the ledger. Benchmark rounds use the same limit (4.0).

import { loadavg } from "node:os";

export const LOAD_LIMIT = 4.0;

/** True when the load is above the limit. A limit of 0 turns the guard off. */
export function loadTooHigh(load: number, limit: number): boolean {
  return limit > 0 && load > limit;
}

/** The one line a skipped tick writes. */
export function loadGuardLine(load: number, limit: number, now: number): string {
  return `${new Date(now).toISOString()} drift loop: load average ${load.toFixed(2)} is above ${limit.toFixed(1)}, so this tick did nothing and marked nothing`;
}

/** The real 1-minute load average. */
export function realLoad(): number {
  return loadavg()[0] ?? 0;
}

/**
 * The tick's guard. True when the tick must do nothing: the one line goes to `log` and the caller exits 0.
 * Nothing is read from or written to the ledger.
 */
export function guardTick(limit: number, load: number, now: number, log: (line: string) => void): boolean {
  if (!loadTooHigh(load, limit)) return false;
  log(loadGuardLine(load, limit, now));
  return true;
}
