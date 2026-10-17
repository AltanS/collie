// The refusal counter (M62 hardening I): how many messages this bridge refused, per reason, and since
// when. No body, no id, no sender: a reason and a count. `<stateDir>/walky/refusals.json`, 0600, read
// by `collie doctor` (check `walky-refusals`) and by the Crew page through `GET /api/walky/who`.
//
//   { "v": 1, "since": <ms>, "counts": { "rate limit": 3, "pair limit": 1 } }
//
// Bounded twice: a reason is cut at its first `:` (so `crew: HTTP 502` and `crew: HTTP 503` are one
// line, `crew`) and to 40 characters, and past 32 distinct reasons the rest count under `other`.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, parseJsonObject } from "../../web/src/lib/json.ts";

export const REFUSAL_REASONS_MAX = 32;
const REASON_LENGTH_MAX = 40;
export const OTHER_REASON = "other";

export interface RefusalCounts {
  /** When the first refusal was counted, or null when none was. */
  readonly since: number | null;
  readonly counts: Readonly<Record<string, number>>;
}

/** The file, in a state dir. */
export function refusalsPath(stateDir: string): string {
  return join(stateDir, "walky", "refusals.json");
}

/** A reason as the counter keys it. */
export function reasonKey(reason: string): string {
  const head = reason.split(":")[0]!.trim().slice(0, REASON_LENGTH_MAX);
  return head === "" ? OTHER_REASON : head;
}

/** The counts in a file's text. Anything that does not parse reads as none. */
export function readRefusals(raw: string | null): RefusalCounts {
  const row = raw === null ? undefined : parseJsonObject(raw);
  if (row?.v !== 1) return { since: null, counts: {} };
  const since = asJsonNumber(row.since) ?? null;
  const counts: Record<string, number> = {};
  for (const [reason, value] of Object.entries(asJsonObject(row.counts) ?? {})) {
    const count = asJsonNumber(value);
    if (count !== undefined && Number.isSafeInteger(count) && count > 0) counts[reasonKey(reason)] = count;
  }
  return { since, counts };
}

/** The counts as one line: `rate limit 3, pair limit 1`, the most first. */
export function refusalLine(counts: RefusalCounts["counts"]): string {
  return Object.entries(counts)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(", ");
}

export class RefusalCounter {
  private state: { since: number | null; counts: Record<string, number> };
  private readonly path: string | null;

  /** `dir` null keeps the counts in memory only. */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.path = dir === null ? null : join(dir, "refusals.json");
    const held = readRefusals(this.path !== null && existsSync(this.path) ? readFileSync(this.path, "utf8") : null);
    this.state = { since: held.since, counts: { ...held.counts } };
  }

  /** Count one refusal. A write that fails costs the count, never the refusal. */
  count(reason: string): void {
    let key = reasonKey(reason);
    const counts = this.state.counts;
    if (counts[key] === undefined && Object.keys(counts).length >= REFUSAL_REASONS_MAX) key = OTHER_REASON;
    counts[key] = (counts[key] ?? 0) + 1;
    this.state.since ??= this.now();
    if (this.path === null || this.dir === null) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, since: this.state.since, counts })}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // The count stays in memory; the next write tries again.
    }
  }

  /** The counts as they stand. */
  current(): RefusalCounts {
    return { since: this.state.since, counts: { ...this.state.counts } };
  }
}
