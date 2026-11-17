import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { JsonValue } from "./json.ts";
import { stateFileIo, type AddedFileIo } from "./launchers-added.ts";
import { asPercent, asWindowKey, cleanWindowText, makeLimit, orderedLimits, USAGE_MAX_AGE_MS, READING_WINDOWS_MAX, type UsageLimit } from "./usage.ts";

// ── The last reading of each account's usage windows, kept on THIS machine (M101 spec 02) ───────
//
// An account with no live session has no live reading. Its page shows the last one the bridge held,
// with its age, so a person still sees "5h 40%, 7d 12%, as of yesterday" and a window that has
// reset since shows as reset. That is this file: `<stateDir>/usage-seen.json`, one per machine, never
// forwarded.
//
// ── NUMBERS, LABELS AND TIMES ONLY ──────────────────────────────────────────────────────────────
// Per key (a harness and the config folder it ran under, "" for the default folder): when the bridge
// held the reading, and per window the harness's key, its label if it has one, the percentage used and
// the reset time. No token, no account id, no mail address, no session id: nothing in a reading carries
// one, and this store takes nothing else.
//
// ── WRITES ARE RARE ─────────────────────────────────────────────────────────────────────────────
// The bridge offers a reading every time it draws a pane. Memory takes every offer. The disk takes a
// key's reading at most once a minute and only when a window's figures changed (the time alone is no
// change), through the same atomic owner-only write as `launchers-added.json` (bridge/launchers-added.ts).
// At most {@link SEEN_KEYS_MAX} keys; the oldest goes. A file that is not ours (not JSON, another
// version) reads as empty and is not written over, as the added launchers' file is.

/** The file's name inside the state dir. */
export const USAGE_SEEN_FILE = "usage-seen.json";
/** The file's schema version. Another number reads as empty and refuses writes. */
export const USAGE_SEEN_VERSION = 1;
/** The most keys the file keeps. The oldest reading goes first. */
export const SEEN_KEYS_MAX = 32;
/** The disk takes a key at most this often. */
export const SEEN_WRITE_EVERY_MS = 60_000;
/**
 * A reading this young counts as live: the account windows' own staleness limit (20 minutes,
 * `STALE_AFTER_MS` in bridge/account-windows.ts). Older, it is a last-seen reading and the page shows its age.
 */
export const SEEN_LIVE_MS = 20 * 60_000;

/** One window of a reading, as the page draws it. `usedPct: null` is a window that has reset since. */
export interface SeenWindow {
  window: string;
  label?: string;
  usedPct: number | null;
  resetsAt: number | null;
}

/** What {@link UsageSeen.reading} answers: the windows and when the bridge held them (epoch ms). */
export interface SeenReading {
  windows: SeenWindow[];
  at: number;
}

interface Entry {
  harness: string;
  /** "" for the harness's default folder. */
  dir: string;
  at: number;
  windows: StoredWindow[];
}

interface StoredWindow {
  window: string;
  label?: string;
  usedPct: number;
  resetsAt: number | null;
}

/** The map key of a harness and a folder. The separator cannot occur in a harness id. */
function keyOf(harness: string, dir: string | undefined): string {
  return `${harness}\u0000${dir === undefined || dir === "" ? "" : join(dir, ".")}`;
}

function storedOf(limit: UsageLimit): StoredWindow | undefined {
  const usedPct = asPercent(limit.used);
  const window = asWindowKey(limit.window);
  if (usedPct === undefined || window === undefined) return undefined;
  const label = limit.label === undefined ? undefined : cleanWindowText(limit.label);
  const resetsAt = limit.resetsAt !== undefined && Number.isFinite(limit.resetsAt) && limit.resetsAt > 0 ? limit.resetsAt : null;
  return label === undefined ? { window, usedPct, resetsAt } : { window, label, usedPct, resetsAt };
}

/**
 * `fresh` plus the windows of `previous` that are missing from it because they have reset: a vendor
 * names a window again only once the next one starts, and "reset since" is what a person should read
 * until then. A window reset more than the usage files' own age ago is let go.
 */
function withReset(fresh: StoredWindow[], previous: Entry | undefined, at: number): StoredWindow[] {
  const carried = (previous?.windows ?? []).filter(
    (w) => w.resetsAt !== null && w.resetsAt <= at && at - w.resetsAt < USAGE_MAX_AGE_MS && !fresh.some((f) => f.window === w.window),
  );
  const all = [...fresh, ...carried];
  const order = orderedLimits(all.map((w) => makeLimit(w.window, w.usedPct, undefined, w.label)));
  return order.flatMap((o) => all.filter((w) => w.window === o.window).slice(0, 1));
}

/** Whether two window lists show the same figures. The time of the reading is not compared. */
function sameWindows(a: readonly StoredWindow[], b: readonly StoredWindow[]): boolean {
  return a.length === b.length && a.every((w, i) => {
    const o = b[i];
    return o !== undefined && w.window === o.window && w.label === o.label && w.usedPct === o.usedPct && w.resetsAt === o.resetsAt;
  });
}

function readStoredWindow(value: JsonValue | undefined): StoredWindow | undefined {
  const row = asJsonObject(value);
  if (row === undefined) return undefined;
  const window = asWindowKey(row.window);
  const used = asPercent(row.usedPct);
  if (window === undefined || used === undefined) return undefined;
  const reset = asJsonNumber(row.resetsAt);
  const resetsAt = reset !== undefined && Number.isFinite(reset) && reset > 0 ? reset : null;
  const text = asJsonString(row.label);
  const label = text === undefined ? undefined : cleanWindowText(text);
  return label === undefined ? { window, usedPct: used, resetsAt } : { window, label, usedPct: used, resetsAt };
}

/** The entries in a file's text: `[]` for no file, `null` for a file that is not ours to write over. */
export function parseSeenText(text: string | null): Entry[] | null {
  if (text === null) return [];
  const root = parseJsonObject(text);
  if (root === undefined || root.version !== USAGE_SEEN_VERSION || !Array.isArray(root.entries)) return null;
  const entries: Entry[] = [];
  for (const raw of root.entries) {
    const row = asJsonObject(raw);
    if (row === undefined) continue;
    const harness = asJsonString(row.harness);
    const dir = asJsonString(row.dir) ?? "";
    const at = asJsonNumber(row.at);
    if (harness === undefined || harness === "" || harness.length > 32 || dir.length > 4096 || at === undefined || !Number.isFinite(at) || at <= 0) continue;
    const windows = (Array.isArray(row.windows) ? row.windows : []).map(readStoredWindow).filter((w): w is StoredWindow => w !== undefined).slice(0, READING_WINDOWS_MAX);
    if (windows.length > 0) entries.push({ harness, dir, at, windows });
  }
  return entries.toSorted((a, b) => b.at - a.at).slice(0, SEEN_KEYS_MAX);
}

/** The text a list of entries is written as. */
export function formatSeenFile(entries: readonly Entry[]): string {
  return `${JSON.stringify({ version: USAGE_SEEN_VERSION, entries }, null, 2)}\n`;
}

function newestFirst(entries: Iterable<Entry>): Entry[] {
  return [...entries].toSorted((a, b) => b.at - a.at).slice(0, SEEN_KEYS_MAX);
}

/** `<stateDir>/usage-seen.json` on the real disk, atomic and owner-only. */
export function usageSeenIo(stateDir: string): AddedFileIo {
  return stateFileIo(stateDir, join(stateDir, USAGE_SEEN_FILE));
}

/**
 * The last reading of each (harness, config folder) the bridge held. `record` is synchronous and
 * cheap (memory, and a queued write at most once a minute per key); `reading` is synchronous and reads memory only.
 */
export class UsageSeen {
  /** Every offer, the newest per key: the live readings. */
  private readonly live = new Map<string, Entry>();
  /** What the file holds, or will hold once the queued write runs. */
  private readonly stored = new Map<string, Entry>();
  private readonly lastWrite = new Map<string, number>();
  private writable = true;
  private queue: Promise<void>;

  constructor(
    private readonly io: AddedFileIo,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.queue = this.load();
  }

  /** Read the file once. A file that is not ours reads as empty and is not written over. */
  private async load(): Promise<void> {
    let entries: Entry[] | null;
    try {
      entries = parseSeenText(await this.io.read());
    } catch (err) {
      this.warn(`[usage] could not read ${USAGE_SEEN_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      entries = null;
    }
    if (entries === null) {
      this.writable = false;
      this.warn(`[usage] ${USAGE_SEEN_FILE} is not a version ${USAGE_SEEN_VERSION} file: no last-seen readings, and none are saved until it is moved away`);
      return;
    }
    for (const entry of entries) {
      const key = keyOf(entry.harness, entry.dir);
      const known = this.stored.get(key);
      if (known === undefined || known.at < entry.at) this.stored.set(key, entry);
    }
  }

  /** Every queued write and the first read, settled. For the tests and a clean stop. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * The bridge holds this reading for `harness` under `dir` (the config folder, absent for the default
   * one), taken at `at`. No windows is no reading and erases nothing. An offer older than the one held is ignored.
   */
  record(harness: string, dir: string | undefined, limits: readonly UsageLimit[], at: number): void {
    const fresh = limits.map(storedOf).filter((w): w is StoredWindow => w !== undefined);
    if (fresh.length === 0 || harness === "" || harness.length > 32 || !Number.isFinite(at) || at <= 0) return;
    const key = keyOf(harness, dir);
    const held = this.live.get(key);
    if (held !== undefined && held.at > at) return;
    const windows = withReset(fresh, held ?? this.stored.get(key), at);
    const entry: Entry = { harness, dir: dir === undefined || dir === "" ? "" : join(dir, "."), at, windows };
    this.live.set(key, entry);
    if (this.live.size > SEEN_KEYS_MAX) {
      const keep = new Set(newestFirst(this.live.values()).map((e) => keyOf(e.harness, e.dir)));
      for (const name of this.live.keys()) if (!keep.has(name)) this.live.delete(name);
    }
    const now = this.now();
    const last = this.lastWrite.get(key);
    if (last !== undefined && now - last < SEEN_WRITE_EVERY_MS) return;
    if (this.stored.get(key) !== undefined && sameWindows(this.stored.get(key)?.windows ?? [], windows)) return;
    this.lastWrite.set(key, now);
    this.queue = this.queue.then(() => this.persist(key));
  }

  /** Write the newest reading of `key`, with the others already on file. Never throws. */
  private async persist(key: string): Promise<void> {
    if (!this.writable) return;
    const entry = this.live.get(key);
    if (entry === undefined) return;
    this.stored.set(key, entry);
    const keep = newestFirst(this.stored.values());
    for (const gone of this.stored.keys()) if (!keep.some((e) => keyOf(e.harness, e.dir) === gone)) this.stored.delete(gone);
    try {
      await this.io.write(formatSeenFile(keep));
    } catch (err) {
      this.warn(`[usage] could not save ${USAGE_SEEN_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The newest reading held for `harness` under `dir`: the live one when it is the newer, else the one on
   * file. A window whose reset time has passed at `now` comes back with `usedPct: null` (reset since). Null when
   * nothing was ever held. `at` tells the caller the age; a reading within {@link SEEN_LIVE_MS} of `now` is live.
   */
  reading(harness: string, dir: string | undefined, now: number): SeenReading | null {
    const key = keyOf(harness, dir);
    const live = this.live.get(key);
    const stored = this.stored.get(key);
    const best = live !== undefined && (stored === undefined || live.at >= stored.at) ? live : stored;
    if (best === undefined) return null;
    const windows = best.windows.map((w): SeenWindow => {
      const reset = w.resetsAt !== null && w.resetsAt <= now;
      const shown: SeenWindow = { window: w.window, usedPct: reset ? null : w.usedPct, resetsAt: w.resetsAt };
      if (w.label !== undefined) shown.label = w.label;
      return shown;
    });
    return { windows, at: best.at };
  }
}
