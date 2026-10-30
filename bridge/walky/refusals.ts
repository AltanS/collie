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

// ── A request a bridge cannot read (added 2026-10-30) ───────────────────────────────────────────
// Every refusal of an unread request opens with `bad request:` and names what failed, so an agent
// never sees the bare word. The bare word is what a bridge before 2026-10-30 answers to anything it
// cannot read, an address form newer than itself included; the CLI asks the next bridge then.

/** What a bridge before 2026-10-30 answers to every request it cannot read, whatever the reason. */
export const BARE_BAD_REQUEST = "bad request";

/** A line that is not one JSON walky request of version 1. */
export const BAD_REQUEST_LINE = "bad request: not one walky request line of version 1";

/** The longest piece of the request a refusal quotes back. */
const QUOTED_MAX = 64;

function quoted(value: string): string {
  return value.length > QUOTED_MAX ? `${value.slice(0, QUOTED_MAX)}...` : value;
}

/** An op this bridge does not know: a newer CLI than the bridge, or a typo. */
export function unknownOp(op: string): string {
  return `bad request: this bridge does not know the op \`${quoted(op)}\`, it may run an older Collie than this command`;
}

/** An address this bridge cannot read: a newer form than the bridge knows, or not an address. */
export function unreadAddress(to: string): string {
  return `bad request: this bridge cannot read the address \`${quoted(to)}\`, it may run an older Collie than this command`;
}

/** A message id, or a reply's id, that is not `wt_` and 12 characters. */
export const BAD_MESSAGE_ID = "bad request: a message id is wt_ and 12 characters";

/** A raw body past the socket's cap, before cleaning. */
export function bodyOverRaw(max: number): string {
  return `bad request: the text is longer than ${String(max)} characters`;
}

/** A send that names no address and replies to nothing. */
export const NO_ADDRESS = "bad request: name an address, or the message id to reply to";

/** An ack that names too many ids, or ids that are not a list. */
export const BAD_ACK_IDS = "bad request: ack takes a list of at most 200 message ids";

/**
 * The CLI's word when a bridge on this machine answered the bare {@link BARE_BAD_REQUEST} and no other
 * bridge took the request: that bridge runs an older Collie, or the request was wrong in a way it did
 * not name. The CLI checked the address itself before it asked.
 */
export const UNREAD_BY_OLDER_BRIDGE = "bad request: a Collie bridge on this machine cannot read this request, it may run an older Collie than this command";
