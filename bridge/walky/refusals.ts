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
  // A Map, never a plain object: a reason such as `constructor` must not read an inherited property.
  const counts = new Map<string, number>();
  for (const [reason, value] of Object.entries(asJsonObject(row.counts) ?? {})) {
    const count = asJsonNumber(value);
    if (count !== undefined && Number.isSafeInteger(count) && count > 0) counts.set(reasonKey(reason), count);
  }
  return { since, counts: Object.fromEntries(counts) };
}

/** The counts as one line: `rate limit 3, pair limit 1`, the most first. */
export function refusalLine(counts: RefusalCounts["counts"]): string {
  return Object.entries(counts)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(", ");
}

export class RefusalCounter {
  private state: { since: number | null; readonly counts: Map<string, number> };
  private readonly path: string | null;

  /** `dir` null keeps the counts in memory only. */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.path = dir === null ? null : join(dir, "refusals.json");
    const held = readRefusals(this.path !== null && existsSync(this.path) ? readFileSync(this.path, "utf8") : null);
    this.state = { since: held.since, counts: new Map(Object.entries(held.counts)) };
  }

  /** Count one refusal. A write that fails costs the count, never the refusal. */
  count(reason: string): void {
    let key = reasonKey(reason);
    const counts = this.state.counts;
    if (!counts.has(key) && counts.size >= REFUSAL_REASONS_MAX) key = OTHER_REASON;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.state.since ??= this.now();
    if (this.path === null || this.dir === null) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, since: this.state.since, counts: Object.fromEntries(counts) })}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // The count stays in memory; the next write tries again.
    }
  }

  /** The counts as they stand. */
  current(): RefusalCounts {
    return { since: this.state.since, counts: Object.fromEntries(this.state.counts) };
  }
}

// ── The refusals of a workspace scope (M75 spec 02) ─────────────────────────────────────────────
// Each reason opens with a fixed key before its first `:`, so the counter keeps one line per kind
// (`reasonKey`), never one per folder or member. What follows names the word and the way out.

/** A bare word that is a member id, or `local`: its panes are `<word>/all`, never a folder. */
export function scopeIsMember(word: string): string {
  return `member word: \`${word}\` is a member; write \`${word}/all\` for its panes`;
}

/** No agent pane anywhere sits in the scope. */
export function scopeEmpty(scope: string): string {
  return `no panes in scope: none in \`${scope}\`, \`collie walky who\` shows the labels`;
}

/** More panes sit in the scope than one message may reach. */
export function scopeTooWide(count: number, max: number): string {
  return `scope too wide: ${String(count)} panes, the most is ${String(max)}`;
}

/** `here` from the phone, or from anyone with no pane. */
export const HERE_FROM_PHONE = "here from a phone: a phone has no workspace, name the folder";

/** `here` from a pane whose label names no folder (the bare pane id). */
export function hereWithoutFolder(label: string): string {
  return `here without a folder: the label \`${label}\` names no folder, name the folder`;
}

/** A member's own check of a scope delivery: the pane the lead named is not in the scope now. */
export const OUT_OF_SCOPE = "out of scope: the pane's label is not in this scope";

/** The line a scope send writes for a member the lead cannot reach: no delivery, no retry. */
export const MEMBER_UNREACHABLE = "unreachable";
