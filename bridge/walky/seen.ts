// Dedupe, in its own file (M62 hardening E): `<stateDir>/walky/seen.json`, one entry per message id
// and target, kept 24 hours, and independent of the log's rotation. The log may drop a line for size
// within a day; this file is what makes "the same id again types nothing" hold anyway.
//
//   { "v": 1, "seen": { "<id>": [ { "target": "<address>", "firstSeen": <ms>, "hash": "<hex>" } ] } }
//
// An entry is written BEFORE the log's message line and before any key, so a crash between the two
// leaves an entry with no log record: a repeat then answers `unknown` and types nothing. `hash` is the
// message's canonical string without the sender's clock (deliver.ts `sameMessage`), so an id reused
// for another message is refused even after the log forgot the first one.
//
// The folder is 0700 and the file 0600, as the log's. A file that does not parse reads as empty: the
// log still answers a repeat for every record it holds.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { canonicalMessage } from "./canonical.ts";
import { WALKY_ID, type WalkyMessage } from "./types.ts";

/** How long an id and target stay seen. */
export const SEEN_KEEP_MS = 24 * 60 * 60 * 1000;
/** The most entries the file holds. Past it the oldest go first. */
export const SEEN_MAX = 20_000;

export interface SeenEntry {
  readonly target: string;
  readonly firstSeen: number;
  readonly hash: string;
}

/** The hash a seen entry keeps: the canonical string with the sender's clock left out. */
export function seenHash(message: WalkyMessage): string {
  return createHash("sha256").update(canonicalMessage({ ...message, at: 0 }), "utf8").digest("hex");
}

export class WalkySeen {
  private readonly path: string | null;
  private readonly entries = new Map<string, SeenEntry[]>();

  /** `dir` null keeps the entries in memory only (a test, or a bridge with no state dir). */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.path = dir === null ? null : join(dir, "seen.json");
    this.load();
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    const row = parseJsonObject(readFileSync(this.path, "utf8"));
    const seen = row?.v === 1 ? asJsonObject(row.seen) : undefined;
    if (seen === undefined) return;
    for (const [id, list] of Object.entries(seen)) {
      if (!WALKY_ID.test(id) || !Array.isArray(list)) continue;
      const kept = list.flatMap((value) => {
        const entry = asJsonObject(value);
        const target = asJsonString(entry?.target);
        const firstSeen = asJsonNumber(entry?.firstSeen);
        const hash = asJsonString(entry?.hash);
        return target === undefined || firstSeen === undefined || hash === undefined ? [] : [{ target, firstSeen, hash }];
      });
      if (kept.length > 0) this.entries.set(id, kept);
    }
    this.prune();
  }

  /** Drop what is older than a day, then the oldest past the cap. True when anything went. */
  private prune(): boolean {
    const floor = this.now() - SEEN_KEEP_MS;
    let dropped = false;
    let total = 0;
    for (const [id, list] of this.entries) {
      const kept = list.filter((entry) => entry.firstSeen >= floor);
      if (kept.length !== list.length) dropped = true;
      if (kept.length === 0) this.entries.delete(id);
      else this.entries.set(id, kept);
      total += kept.length;
    }
    if (total <= SEEN_MAX) return dropped;
    const all = [...this.entries].flatMap(([id, list]) => list.map((entry) => ({ id, entry }))).toSorted((a, b) => a.entry.firstSeen - b.entry.firstSeen);
    for (const { id, entry } of all.slice(0, total - SEEN_MAX)) {
      const rest = (this.entries.get(id) ?? []).filter((held) => held !== entry);
      if (rest.length === 0) this.entries.delete(id);
      else this.entries.set(id, rest);
    }
    return true;
  }

  private write(): void {
    if (this.path === null || this.dir === null) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, seen: Object.fromEntries(this.entries) })}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /** Every target this id was seen for, oldest first. */
  of(id: string): readonly SeenEntry[] {
    return this.entries.get(id) ?? [];
  }

  /** Whether this id was seen for this target. */
  has(id: string, target: string): boolean {
    return this.of(id).some((entry) => entry.target === target);
  }

  /** Mark one id and target seen, on disk before it returns. Once only. */
  add(message: WalkyMessage, target: string): void {
    if (this.has(message.id, target)) return;
    this.entries.set(message.id, [...this.of(message.id), { target, firstSeen: this.now(), hash: seenHash(message) }]);
    this.prune();
    this.write();
  }
}
