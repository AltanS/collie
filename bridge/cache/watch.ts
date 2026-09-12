// Which panes the operator asked to be warned about, and which deadlines have already been warned.
//
// `NotifyPrefsStore`'s sibling, line for line: `load()`, a `current()` that copies, a mutator per act,
// and an atomic owner-only save (0600 temp file renamed over the target). Bridge-wide, not per-device,
// for the reason stated at the top of `bridge/notify-prefs.ts`: a push fans out to every subscribed
// device, so there is nothing per-device to keep.
//
// ── THE FILE IS WRITTEN BY TWO EVENTS, AND BY NOTHING ELSE ────────────────────
// An operator toggle, and a warning actually going out. A bridge nobody toggles and that never warns
// writes no `cache-watch.json` at all, which is what keeps `bridge/solo-baseline.test.ts`'s
// written-entries assertion at four (§11).
//
// `lastSeenAt` is deliberately NOT one of those events. It is refreshed in memory on every tick where
// the entry's session appears, and reaches disk on the next save one of the two real events causes. A
// write per poll would be a file written every 1.5 s for as long as one pane is watched.
//
// ── WHY `sent` IS PERSISTED AT ALL ───────────────────────────────────────────
// `make deploy` restarts the dev bridge most days. An in-memory set would re-warn every watched pane
// whose deadline is still ahead, which is a duplicate buzz on a real phone on a schedule. It is pruned
// on every save to the deadlines still in the future, so the array is bounded by the warm cycles in
// flight — which is bounded by the number of agent panes.
//
// Pruning does NOT filter by "still watched": the global switch warns panes that have no entry, and
// dropping their marks would un-dedupe exactly the case the persistence exists for.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "../json.ts";
import { sentMarkOf, UNSEEN_GRACE_MS, watchIdOf, watchKeyOf, type WatchIdentity } from "./watch-key.ts";

export { sentMarkOf, UNSEEN_GRACE_MS, watchIdOf, watchKeyOf, type WatchIdentity };

/** One watched pane, as stored. `label` is display only and is refreshed on every write. */
export interface CacheWatchEntry {
  /** The crew member the pane lives on. Absent for this collie's own panes, never null. */
  host?: string;
  /** The named Herdr session. Absent for the primary, the same omitted-not-null rule. */
  session?: string;
  /** See `watch-key.ts`: a harness session ref locally, `pane:<id>` for a peer's pane. */
  ref: string;
  label: string;
  lastSeenAt: number;
}

/** One deadline already pushed. At most one push per pair, across restarts (ADR 0042). */
export interface CacheWatchSent {
  key: string;
  expiresAt: number;
}

/** One entry as the phone reads it: an opaque id, a label, and the address to link by when there is one. */
export interface CacheWatchListEntry {
  id: string;
  label: string;
  host?: string;
  session?: string;
  /** Present only while the entry's pane is in the current snapshot. An entry with none still removes. */
  paneId?: string;
}

/**
 * What the warden needs of the store, and nothing more. The test fakes this interface rather than the
 * class, so `bridge/cache/warden.test.ts` needs no state directory.
 */
export interface CacheWatchLedger {
  /** Is this key on the list? The per-pane half of "global OR per-pane". */
  has(key: string): boolean;
  /** The `(key, expiresAt)` marks already pushed, as `sentMarkOf` spells them. */
  sentMarks(): ReadonlySet<string>;
  /** These keys are in the current snapshot — refresh their grace clock. In memory; never a write. */
  seen(keys: readonly string[], at: number): void;
  /** Record what just went out, and persist. The only write the warden ever causes. */
  markSent(pairs: readonly CacheWatchSent[]): Promise<void>;
}

/**
 * What the ROUTES need of the store. `bridge/server.ts` holds this, never the class, so the HTTP layer
 * cannot reach the file, the prune or the clock.
 */
export interface CacheWatchSurface {
  current(): readonly CacheWatchEntry[];
  has(key: string): boolean;
  set(identity: WatchIdentity, label: string, on: boolean): Promise<void>;
  forget(id: string): Promise<void>;
  list(paneIdFor: (entry: CacheWatchEntry) => string | undefined): CacheWatchListEntry[];
}

/** The file's current shape. A future change bumps this and coerces the old one. */
export const CACHE_WATCH_VERSION = 1;

/** The file, parsed. The named owner of what {@link coerceCacheWatchFile} returns. */
export interface CacheWatchFile {
  entries: CacheWatchEntry[];
  sent: CacheWatchSent[];
}

/** Coerce an untrusted parsed file into entries and sent pairs. Pure, so the shape handling is tested. */
export function coerceCacheWatchFile(raw: JsonValue | undefined): CacheWatchFile {
  const o = asRecord(raw);
  const entries: CacheWatchEntry[] = [];
  for (const row of asArray(o?.entries)) {
    const r = asRecord(row);
    if (r === null || typeof r.ref !== "string" || r.ref === "") continue;
    const entry: CacheWatchEntry = {
      ref: r.ref,
      label: typeof r.label === "string" ? r.label : "",
      lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : 0,
    };
    if (typeof r.host === "string" && r.host !== "") entry.host = r.host;
    if (typeof r.session === "string" && r.session !== "") entry.session = r.session;
    entries.push(entry);
  }
  const sent: CacheWatchSent[] = [];
  for (const row of asArray(o?.sent)) {
    const r = asRecord(row);
    if (r === null || typeof r.key !== "string" || typeof r.expiresAt !== "number") continue;
    sent.push({ key: r.key, expiresAt: r.expiresAt });
  }
  return { entries, sent };
}

export class CacheWatchStore implements CacheWatchLedger {
  private entries: CacheWatchEntry[] = [];

  private sent: CacheWatchSent[] = [];

  private readonly file: string;

  constructor(
    private readonly cfg: { stateDir: string },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = join(cfg.stateDir, "cache-watch.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = coerceCacheWatchFile(await Bun.file(this.file).json());
      this.entries = parsed.entries;
      this.sent = parsed.sent;
    } catch {
      /* nothing watched yet — and asking the question must not create the file */
    }
  }

  /** Copies, never the internal rows, so a caller cannot mutate the store's state. */
  current(): readonly CacheWatchEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  has(key: string): boolean {
    return this.entries.some((e) => watchKeyOf(e) === key);
  }

  sentMarks(): ReadonlySet<string> {
    return new Set(this.sent.map((s) => sentMarkOf(s.key, s.expiresAt)));
  }

  seen(keys: readonly string[], at: number): void {
    const live = new Set(keys);
    for (const entry of this.entries) {
      if (live.has(watchKeyOf(entry))) entry.lastSeenAt = at;
    }
  }

  /**
   * Add or remove one pane. `label` is taken on every add, so a renamed pane's row reads correctly
   * without the key moving — the label is display only and is never part of the key.
   */
  async set(identity: WatchIdentity, label: string, on: boolean): Promise<void> {
    const key = watchKeyOf(identity);
    this.entries = this.entries.filter((e) => watchKeyOf(e) !== key);
    if (on) {
      const entry: CacheWatchEntry = { ref: identity.ref, label, lastSeenAt: this.now() };
      if (identity.host !== undefined) entry.host = identity.host;
      if (identity.session !== undefined) entry.session = identity.session;
      this.entries.push(entry);
    }
    await this.save();
  }

  /**
   * Remove the entry an opaque id names. An id naming nothing is not an error: removing something
   * already gone is the outcome the operator asked for.
   */
  async forget(id: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => watchIdOf(watchKeyOf(e)) !== id);
    if (this.entries.length !== before) await this.save();
  }

  async markSent(pairs: readonly CacheWatchSent[]): Promise<void> {
    if (pairs.length === 0) return;
    this.sent.push(...pairs.map((p) => ({ ...p })));
    await this.save();
  }

  /**
   * The list the phone renders. `paneId` and `session` are filled from the snapshot the caller passes,
   * so an entry whose pane is gone still lists and still removes; it simply cannot be linked.
   */
  list(paneIdFor: (entry: CacheWatchEntry) => string | undefined): CacheWatchListEntry[] {
    return this.entries.map((entry) => {
      const row: CacheWatchListEntry = { id: watchIdOf(watchKeyOf(entry)), label: entry.label };
      if (entry.host !== undefined) row.host = entry.host;
      if (entry.session !== undefined) row.session = entry.session;
      const paneId = paneIdFor(entry);
      if (paneId !== undefined) row.paneId = paneId;
      return row;
    });
  }

  /**
   * Atomic, owner-only write: fresh temp file (mode 0600) then rename over the target.
   *
   * Both prunes happen HERE rather than on a timer, so the file is tidied exactly when it is already
   * being rewritten: an entry unseen for {@link UNSEEN_GRACE_MS} goes (a peer that rebooted must not
   * silently empty a curated list, and a day covers a reboot, a moved laptop and a night), and a sent
   * mark whose deadline has passed goes with it.
   */
  private async save(): Promise<void> {
    const at = this.now();
    this.entries = this.entries.filter((e) => at - e.lastSeenAt <= UNSEEN_GRACE_MS);
    this.sent = this.sent.filter((s) => s.expiresAt > at);
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const body = { version: CACHE_WATCH_VERSION, entries: this.entries, sent: this.sent };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

function asRecord(v: JsonValue | undefined): JsonObject | null {
  return typeof v === "object" && v !== null && v !== undefined && !Array.isArray(v) ? v : null;
}

function asArray(v: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(v) ? v : [];
}
