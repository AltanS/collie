// The Surface counters, the manual-send cap and the lab's two folders (M56 spec 09).
//
// Every Surface verdict and every send outcome is counted per harness, version, profile id and profile
// status, in one JSON file per day under `<stateDir>/surface/counters-<date>.json`. Fourteen days are
// kept, and a file is written at most once a minute. `collie doctor` and `GET /api/health` read the
// last seven days; the lab clusters the frames of the `unknown` verdicts by their hash.
//
// What no file holds: a row of the screen, the text of a message. The counters hold numbers, the
// `unknown` frames hold a short hash of the bottom cluster (never the rows), the inbox holds hashes and
// the version, and an example holds the bottom cluster as a SHAPE: every letter and digit is replaced
// by a class mark, so the layout of the box, the rules and the status row survive and no word does.
// Rows can carry secrets (the receipts' own rule), so a reader of the examples folder learns where the
// box was and how wide a line was, and nothing else.
//
// Counters never block a send and never change a verdict: every call here is a plain write after the
// fact, the callers wrap each one, and a write that fails is a warning in the journal.
//
// Pure helpers first (the file shape, the merge, the summary), then the ledger that holds the day's file.
// No harness name lives here (bridge/surface/no-harness-names.test.ts scans this folder).

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { askOf, isFree, type Surface } from "../../web/src/lib/surface/surface.ts";

/** How many days of counters are kept. */
export const KEEP_DAYS = 14;
/** The window `collie doctor` and `/api/health` read. */
export const SUMMARY_DAYS = 7;
/** A counters file is written at most this often. */
export const WRITE_EVERY_MS = 60_000;
/** The cap: manual sends on one harness and version inside {@link CAP_WINDOW_MS} before one more confirm. */
export const DEFAULT_CAP = 5;
/** The window the cap counts in. */
export const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most sent example files kept; the oldest go first. */
export const MAX_EXAMPLES = 50;
/** The most refused (negative) example files kept, on their own cap; the oldest go first. One per
 *  frame hash and reason per day, so one screen refused many times fills one slot. */
export const MAX_NEGATIVE_EXAMPLES = 10;
/** The marker in a negative example's file name: `<at>-refused-<day>-<frame>-<reason>.json`. */
const NEGATIVE_MARK = "-refused-";
/** The most frame hashes one row keeps per day. A hash is nine bytes of a day's cluster; a few hundred is plenty. */
export const MAX_FRAME_HASHES = 200;
/** The inbox is cut back to its newest lines past this size. */
export const INBOX_MAX_BYTES = 256 * 1024;
/** The lines the inbox keeps after a cut. */
export const INBOX_KEEP_LINES = 500;
/** The most manual stamps one harness and version keeps per day file. The cap never needs more than its own N. */
const MAX_STAMPS = 64;

/** Which row of the table a count belongs to. `-` stands for "no profile" and "no version". */
export interface CounterKey {
  readonly harness: string;
  readonly version: string;
  readonly profileId: string;
  /** `verified`, `provisional`, `revoked`, or `-` with no profile. */
  readonly status: string;
}

/** One row: the counts for one {@link CounterKey}. */
export interface CounterRow extends CounterKey {
  free: number;
  /** `unknown` verdicts by reason (`no-match`, `contested`, `stale`, `torn`, `weak-cue`, `other`). */
  unknown: Record<string, number>;
  /** Verdicts with a modal up, by kind (`permission`, `question`, `menu`, `unreadable`). */
  modal: Record<string, number>;
  /** Sends refused, by reason. */
  refused: Record<string, number>;
  /** Sends that took the probed path. */
  probed: number;
  /** Sends the person confirmed on a screen Collie could not read (the manual Send). */
  manual: number;
  /** Sends that ended `sent`. */
  sent: number;
  /** Sends that ended `effective`. */
  effective: number;
  /** Sends that ended `unknown`. */
  unknown_outcome: number;
  /** Sends that ended `typed_not_submitted`: the text went into the box, Enter did not. */
  typed_not_submitted: number;
  /** Discards that emptied the box. Never counted under `sent`: nothing went to the agent. */
  discarded: number;
  /** Sends the harness could not take during its turn, so Collie held them (M56 spec 15). */
  held: number;
  /** Held sends that went out once the pane read free (also counted under `sent` or `effective`). */
  held_sent: number;
  /** Held sends that nobody could send within 30 minutes. */
  held_expired: number;
  /** Held sends the person cancelled before they went out. */
  held_cancelled: number;
  /**
   * Hook edges (M56 spec 11), by word: each edge kind (`prompt`, `stop`, `dialog`, `start`, `end`,
   * `reread`) as a pane took it, `lost-stop` for a block the screen ended with free reads,
   * `stop-receipt` for Collie's own Stop receipt `stopped` taken as a stop edge (M68), and `dropped`
   * for an edge no pane could be found for (counted under the edge's harness, version `-`).
   */
  edges: Record<string, number>;
  /**
   * Hook-held permissions (M56 spec 12), by outcome: `phone` (the tap reached the hook and took
   * effect), `desk` (the desk or another hook answered first), `void` (the hook stopped, or another
   * Collie answered), `timeout` (the hold reached its limit), `mismatch` (an answer with another hash).
   */
  holds: Record<string, number>;
}

/** One day's file. */
export interface CountersDay {
  readonly date: string;
  readonly rows: Record<string, CounterRow>;
  /** Short hashes of the bottom cluster of each `unknown` verdict, per row key, so the lab can cluster frames. */
  readonly unknownFrames: Record<string, string[]>;
  /** When each `harness@version` sent a manual send, newest last, for the cap. */
  readonly manualAt: Record<string, number[]>;
}

/** The totals `make health` and `GET /api/health` carry. */
export interface SurfaceTotals {
  readonly free: number;
  /** `unknown` verdicts, every reason. */
  readonly unknown: number;
  readonly manual: number;
}

/** The cap's answer for a manual send about to go. */
export interface CapState {
  /** Manual sends on this harness and version inside the window. */
  readonly count: number;
  readonly limit: number;
  /** True when the next manual send needs one more confirm. */
  readonly reached: boolean;
}

/** `YYYY-MM-DD` of a moment, in UTC, so a day file does not move with the zone. */
/** A piece of a file name: letters, digits, `_` and `.` only; anything else becomes `_`. */
function safeName(piece: string): string {
  return piece.replace(/[^A-Za-z0-9_.]/gu, "_").slice(0, 64);
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The key of a row inside a day file. */
export function rowKey(key: CounterKey): string {
  return `${key.harness}|${key.version}|${key.profileId}|${key.status}`;
}

export function emptyRow(key: CounterKey): CounterRow {
  return { harness: key.harness, version: key.version, profileId: key.profileId, status: key.status, free: 0, unknown: {}, modal: {}, refused: {}, probed: 0, manual: 0, sent: 0, effective: 0, unknown_outcome: 0, typed_not_submitted: 0, discarded: 0, held: 0, held_sent: 0, held_expired: 0, held_cancelled: 0, edges: {}, holds: {} };
}

export function emptyDay(date: string): CountersDay {
  return { date, rows: {}, unknownFrames: {}, manualAt: {} };
}

function bump(record: Record<string, number>, word: string, by = 1): void {
  record[word] = (record[word] ?? 0) + by;
}

/** How a read counts: free, a modal of some kind, or unknown with a reason. A read can also be none of them (a draft, a running turn). */
export interface ReadClass {
  readonly free: boolean;
  readonly modal?: string;
  readonly unknown?: string;
}

/**
 * What one Surface verdict adds to the table. A modal comes first: an ask by its kind, an overlay
 * Collie cannot read as `unreadable`. A verdict that is neither free nor a modal and has an unknown
 * claim counts under its reason; a weak cue (modal unknown, no reason) is `weak-cue`.
 */
export function classifyRead(surface: Surface): ReadClass {
  const free = isFree(surface);
  const ask = askOf(surface.modal);
  if (ask !== null) return { free, modal: ask.kind };
  if (surface.modal === "unreadable") return { free, modal: "unreadable" };
  const anyUnknown = surface.turn === "unknown" || surface.modal === "unknown" || surface.composer === "unknown";
  if (!free && anyUnknown) return { free, unknown: surface.reason ?? (surface.modal === "unknown" ? "weak-cue" : "other") };
  return { free };
}

function parseCountMap(value: JsonValue | undefined): Record<string, number> {
  const node = asJsonObject(value);
  if (node === undefined) return {};
  return Object.fromEntries(
    Object.entries(node).flatMap(([word, n]) => {
      const count = asJsonNumber(n);
      return count !== undefined && Number.isFinite(count) && count >= 0 ? [[word, count] as const] : [];
    }),
  );
}

function parseRow(value: JsonValue | undefined): CounterRow | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const harness = asJsonString(node.harness);
  const version = asJsonString(node.version);
  const profileId = asJsonString(node.profileId);
  const status = asJsonString(node.status);
  if (harness === undefined || version === undefined || profileId === undefined || status === undefined) return null;
  const count = (word: string): number => {
    const n = asJsonNumber(node[word]);
    return n !== undefined && Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    harness,
    version,
    profileId,
    status,
    free: count("free"),
    unknown: parseCountMap(node.unknown),
    modal: parseCountMap(node.modal),
    refused: parseCountMap(node.refused),
    probed: count("probed"),
    manual: count("manual"),
    sent: count("sent"),
    effective: count("effective"),
    unknown_outcome: count("unknown_outcome"),
    typed_not_submitted: count("typed_not_submitted"),
    discarded: count("discarded"),
    held: count("held"),
    held_sent: count("held_sent"),
    held_expired: count("held_expired"),
    held_cancelled: count("held_cancelled"),
    edges: parseCountMap(node.edges),
    holds: parseCountMap(node.holds),
  };
}

/** A day file read back, every field checked; null when it is not one this module wrote. */
export function parseDay(raw: JsonValue | undefined): CountersDay | null {
  const node = asJsonObject(raw);
  if (node === undefined) return null;
  const date = asJsonString(node.date);
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const rows: Record<string, CounterRow> = {};
  for (const value of Object.values(asJsonObject(node.rows) ?? {})) {
    const row = parseRow(value);
    if (row !== null) rows[rowKey(row)] = row;
  }
  const unknownFrames: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(asJsonObject(node.unknownFrames) ?? {})) {
    if (!Array.isArray(list)) continue;
    unknownFrames[key] = list.flatMap((hash) => {
      const word = asJsonString(hash);
      return word !== undefined && /^[0-9a-f]{1,64}$/u.test(word) ? [word] : [];
    }).slice(0, MAX_FRAME_HASHES);
  }
  const manualAt: Record<string, number[]> = {};
  for (const [key, list] of Object.entries(asJsonObject(node.manualAt) ?? {})) {
    if (!Array.isArray(list)) continue;
    manualAt[key] = list.flatMap((at) => {
      const stamp = asJsonNumber(at);
      return stamp !== undefined && Number.isFinite(stamp) ? [stamp] : [];
    }).slice(-MAX_STAMPS);
  }
  return { date, rows, unknownFrames, manualAt };
}

function addRow(into: CounterRow, from: CounterRow): void {
  into.free += from.free;
  for (const [word, n] of Object.entries(from.unknown)) bump(into.unknown, word, n);
  for (const [word, n] of Object.entries(from.modal)) bump(into.modal, word, n);
  for (const [word, n] of Object.entries(from.refused)) bump(into.refused, word, n);
  into.probed += from.probed;
  into.manual += from.manual;
  into.sent += from.sent;
  into.effective += from.effective;
  into.unknown_outcome += from.unknown_outcome;
  into.typed_not_submitted += from.typed_not_submitted;
  into.discarded += from.discarded;
  into.held += from.held;
  into.held_sent += from.held_sent;
  into.held_expired += from.held_expired;
  into.held_cancelled += from.held_cancelled;
  for (const [word, n] of Object.entries(from.edges)) bump(into.edges, word, n);
  for (const [word, n] of Object.entries(from.holds)) bump(into.holds, word, n);
}

/** The rows of several days added up by key, sorted by harness, then version. */
export function summarize(days: readonly CountersDay[]): CounterRow[] {
  const merged = new Map<string, CounterRow>();
  for (const day of days) {
    for (const [key, row] of Object.entries(day.rows)) {
      let into = merged.get(key);
      if (into === undefined) {
        into = emptyRow(row);
        merged.set(key, into);
      }
      addRow(into, row);
    }
  }
  return [...merged.values()].toSorted((a, b) => a.harness.localeCompare(b.harness) || a.version.localeCompare(b.version, undefined, { numeric: true }) || a.profileId.localeCompare(b.profileId));
}

/** The number of `unknown` verdicts in a row, every reason. */
export function unknownTotal(row: CounterRow): number {
  return Object.values(row.unknown).reduce((sum, n) => sum + n, 0);
}

/** The totals of some rows. */
export function totalsOf(rows: readonly CounterRow[]): SurfaceTotals {
  return rows.reduce<SurfaceTotals>((sum, row) => ({ free: sum.free + row.free, unknown: sum.unknown + unknownTotal(row), manual: sum.manual + row.manual }), { free: 0, unknown: 0, manual: 0 });
}

/** The newest `count` day files' dates among `names`, newest first. A name that is not a counters file is skipped. */
export function counterDates(names: readonly string[]): string[] {
  return names
    .flatMap((name) => {
      const found = /^counters-(\d{4}-\d{2}-\d{2})\.json$/u.exec(name);
      return found === null ? [] : [found[1]!];
    })
    .toSorted()
    .toReversed();
}

/** The path of one day's file. */
export function counterPath(dir: string, date: string): string {
  return join(dir, `counters-${date}.json`);
}

/** Reads the last `days` days of counters out of a surface folder, newest last. Read-only: `collie doctor` calls it. */
export function readDays(
  dir: string,
  now: number,
  days: number,
  io: { readonly list: (p: string) => string[]; readonly read: (p: string) => string | null } = {
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  },
): CountersDay[] {
  const earliest = dayOf(now - (days - 1) * 24 * 60 * 60 * 1000);
  const out: CountersDay[] = [];
  for (const date of counterDates(io.list(dir))) {
    if (date < earliest) continue;
    const text = io.read(counterPath(dir, date));
    if (text === null) continue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue; `parseDay` checks every field.
      const day = parseDay(JSON.parse(text) as JsonValue);
      if (day !== null) out.push(day);
    } catch {
      // A torn or foreign file is skipped: a read of counters never fails a verb.
    }
  }
  return out.toSorted((a, b) => a.date.localeCompare(b.date));
}

/**
 * A row as the lab may keep it: whitespace and box-drawing or block characters (U+2500 to U+259F) stay,
 * because they are the layout the mask exists to show. Every letter becomes `a` (no case class), every
 * digit `0`, and every other character `x`, so a secret leaks neither its symbols nor its case.
 */
export function maskRow(row: string): string {
  let out = "";
  for (const ch of row) {
    const code = ch.codePointAt(0) ?? 0;
    if (/\s/u.test(ch) || (code >= 0x2500 && code <= 0x259f)) out += ch;
    else if (/\p{L}/u.test(ch)) out += "a";
    else if (/\p{N}/u.test(ch)) out += "0";
    else out += "x";
  }
  return out.trimEnd();
}

/** What a manual-send cap refusal files for the lab: hashes and the version, never rows or text. */
export interface InboxEntry {
  readonly harness: string;
  readonly version: string;
  readonly profileId: string;
  readonly status: string;
  /** The short hash of the bottom cluster the person was asked to confirm. */
  readonly frame: string;
  /** The manual sends counted inside the window when the cap stopped this one. */
  readonly count: number;
}

/** A cue a refusal's read found: its kind, and its row as a shape. */
export interface ExampleCue {
  readonly kind: string;
  /** The cue's row inside `cluster`, or null when it sits above the cluster. */
  readonly at: number | null;
  /** The cue's row as read. Masked like the cluster before it is written. */
  readonly row: string;
}

/**
 * A request kept as an example: the bottom cluster as a shape, the text as a length. A probed send
 * that settled is a positive one. A refusal whose modal read `unreadable` or `unknown` is a negative
 * one, with its reason, its modal and the cues that read: the shape a reader may have to learn.
 */
export interface ExampleEntry {
  readonly requestId: string;
  readonly harness: string;
  readonly version: string;
  readonly profileId: string;
  readonly status: string;
  readonly outcome: "sent" | "effective" | "refused";
  /** A refusal's reason. */
  readonly reason?: string;
  /** A refusal's modal. */
  readonly modal?: "unreadable" | "unknown";
  /** A refusal's cues, read with the frame the profile found. */
  readonly cues?: readonly ExampleCue[];
  /** The bottom cluster of the read, rows as shapes: S0 for a send, the last read for a refusal. */
  readonly cluster: readonly string[];
  /** The short hash of the cluster, the same one a refusal names. */
  readonly frame: string;
  /** The typed text's length: the marker that stands for it. */
  readonly textLength: number;
}

export interface LedgerOptions {
  readonly now?: () => number;
  /** The manual-send cap, default {@link DEFAULT_CAP}. */
  readonly cap?: number;
  readonly writeEveryMs?: number;
  /** Test seam for the trailing write. Defaults to an unref'd timer. */
  readonly schedule?: (run: () => void, ms: number) => void;
  /** Where a failed write is told. Defaults to `console.warn`. */
  readonly warn?: (line: string) => void;
}

/** The ledger of one state directory: today's file in memory, flushed at most once a minute. */
export class SurfaceLedger {
  readonly dir: string;
  private readonly now: () => number;
  private readonly cap: number;
  private readonly writeEveryMs: number;
  private readonly schedule: (run: () => void, ms: number) => void;
  private readonly warn: (line: string) => void;
  private day: CountersDay;
  /** Manual stamps from the day before, so a cap window that crosses midnight still counts them. */
  private carried: Record<string, number[]> = {};
  private dirty = false;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(stateDir: string, options: LedgerOptions = {}) {
    this.dir = join(stateDir, "surface");
    this.now = options.now ?? (() => Date.now());
    this.cap = options.cap ?? DEFAULT_CAP;
    this.writeEveryMs = options.writeEveryMs ?? WRITE_EVERY_MS;
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
      });
    this.warn = options.warn ?? ((line) => console.warn(line));
    this.day = this.load(dayOf(this.now()));
    this.carried = this.load(dayOf(this.now() - CAP_WINDOW_MS)).manualAt;
    this.prune();
  }

  /** Today's file as it stands on disk, or an empty day. */
  private load(date: string): CountersDay {
    const path = counterPath(this.dir, date);
    if (!existsSync(path)) return emptyDay(date);
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue; `parseDay` checks every field.
      return parseDay(JSON.parse(readFileSync(path, "utf8")) as JsonValue) ?? emptyDay(date);
    } catch {
      return emptyDay(date);
    }
  }

  /** Rolls to a new day file when the date moved: the old day is written first, and the manual stamps ride over. */
  private roll(): void {
    const date = dayOf(this.now());
    if (date === this.day.date) return;
    this.write();
    this.carried = this.day.manualAt;
    this.day = date > this.day.date ? emptyDay(date) : this.load(date);
    this.prune();
  }

  private row(key: CounterKey): CounterRow {
    this.roll();
    const id = rowKey(key);
    let row = this.day.rows[id];
    if (row === undefined) {
      row = emptyRow(key);
      this.day.rows[id] = row;
    }
    return row;
  }

  /** One Surface verdict. An `unknown` one also files the short hash of its bottom cluster, once per day and row. */
  read(key: CounterKey, surface: Surface, frame: string | null): void {
    const row = this.row(key);
    const klass = classifyRead(surface);
    if (klass.free) row.free++;
    if (klass.modal !== undefined) bump(row.modal, klass.modal);
    if (klass.unknown !== undefined) {
      bump(row.unknown, klass.unknown);
      if (frame !== null) {
        const id = rowKey(key);
        const frames = (this.day.unknownFrames[id] ??= []);
        if (!frames.includes(frame) && frames.length < MAX_FRAME_HASHES) frames.push(frame);
      }
    }
    this.touch();
  }

  /**
   * One settled send. `probed` is whether it took the probed path; `released` whether it was the run of
   * a held request (M56 spec 15), whose `sent` or `effective` also counts as `held_sent`. A `held`
   * answer counts once when the send is held; its end (`expired`, `cancelled`, or the release's own
   * outcome) counts again.
   */
  send(key: CounterKey, end: { readonly outcome: string; readonly reason?: string | undefined; readonly probed: boolean; readonly released?: boolean }): void {
    const row = this.row(key);
    if (end.outcome === "refused") bump(row.refused, end.reason ?? "other");
    else if (end.outcome === "sent") row.sent++;
    else if (end.outcome === "effective") row.effective++;
    else if (end.outcome === "unknown") row.unknown_outcome++;
    else if (end.outcome === "typed_not_submitted") row.typed_not_submitted++;
    else if (end.outcome === "discarded") row.discarded++;
    else if (end.outcome === "held") row.held++;
    else if (end.outcome === "expired") row.held_expired++;
    else if (end.outcome === "cancelled") row.held_cancelled++;
    if (end.released === true && (end.outcome === "sent" || end.outcome === "effective")) row.held_sent++;
    if (end.probed) row.probed++;
    this.touch();
  }

  /** One hook edge word (M56 spec 11): an edge kind a pane took, `lost-stop`, or `dropped`. */
  edge(key: CounterKey, word: string): void {
    const row = this.row(key);
    bump(row.edges, word);
    this.touch();
  }

  /** One hook-held permission's outcome (M56 spec 12): `phone`, `desk`, `void`, `timeout` or `mismatch`. */
  hold(key: CounterKey, word: string): void {
    const row = this.row(key);
    bump(row.holds, word);
    this.touch();
  }

  /**
   * A settled `sent` or `unknown` that a matching prompt edge confirmed (M56 spec 11): it moves to
   * `effective`. An outcome counted on an earlier day stays there; today's row only gains the effective.
   */
  confirmEffective(key: CounterKey, from: "sent" | "unknown"): void {
    const row = this.row(key);
    if (from === "sent" && row.sent > 0) row.sent--;
    if (from === "unknown" && row.unknown_outcome > 0) row.unknown_outcome--;
    row.effective++;
    this.touch();
  }

  /** The cap's state for a harness and version: the manual sends inside the last 24 hours. */
  capState(harness: string, version: string): CapState {
    this.roll();
    const id = `${harness}@${version}`;
    const since = this.now() - CAP_WINDOW_MS;
    const stamps = [...(this.carried[id] ?? []), ...(this.day.manualAt[id] ?? [])];
    const count = stamps.filter((at) => at > since).length;
    return { count, limit: this.cap, reached: count >= this.cap };
  }

  /** A manual send went through the gate: count it and stamp it for the cap. */
  noteManual(key: CounterKey): void {
    const row = this.row(key);
    row.manual++;
    const id = `${key.harness}@${key.version}`;
    const stamps = (this.day.manualAt[id] ??= []);
    stamps.push(this.now());
    if (stamps.length > MAX_STAMPS) stamps.splice(0, stamps.length - MAX_STAMPS);
    this.touch();
  }

  /** A cap refusal's line for the lab: `<stateDir>/surface/inbox.jsonl`. The newest lines are kept. */
  inbox(entry: InboxEntry): void {
    try {
      this.ensureDir();
      const path = join(this.dir, "inbox.jsonl");
      const line = `${JSON.stringify({ at: this.now(), ...entry })}\n`;
      writeFileSync(path, line, { flag: "a", mode: 0o600 });
      if (statSync(path).size > INBOX_MAX_BYTES) {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
        writeFileSync(path, `${lines.slice(-INBOX_KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
      }
    } catch (err) {
      this.warn(`[surface] could not write the inbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The folder of examples, positive and negative. `collie doctor` names it. */
  get examplesDir(): string {
    return join(this.dir, "examples");
  }

  /** A probed send that settled, or a refusal over a screen Collie could not read: its bottom cluster
   *  and its cue rows as shapes. Sent examples keep at most {@link MAX_EXAMPLES} files and refused ones
   *  at most {@link MAX_NEGATIVE_EXAMPLES}, each cap on its own, oldest dropped. A refusal files once per
   *  frame hash and reason per day: the same screen refused again adds nothing. */
  example(entry: ExampleEntry): void {
    try {
      mkdirSync(this.examplesDir, { recursive: true, mode: 0o700 });
      const at = this.now();
      const negative = entry.outcome === "refused";
      const stamp = String(at).padStart(14, "0");
      const key = `${NEGATIVE_MARK}${dayOf(at)}-${safeName(entry.frame)}-${safeName(entry.reason ?? "-")}`;
      const present = readdirSync(this.examplesDir).filter((file) => file.endsWith(".json"));
      if (negative && present.some((file) => file.slice(stamp.length) === `${key}.json`)) return;
      const name = negative ? `${stamp}${key}.json` : `${stamp}-${entry.requestId}.json`;
      const masked = { at, ...entry, cluster: entry.cluster.map(maskRow), text: `<typed:${String(entry.textLength)}>` };
      const body = entry.cues === undefined ? masked : { ...masked, cues: entry.cues.map((cue) => ({ ...cue, row: maskRow(cue.row) })) };
      writeFileSync(join(this.examplesDir, name), `${JSON.stringify(body)}\n`, { mode: 0o600 });
      const files = readdirSync(this.examplesDir).filter((file) => file.endsWith(".json")).toSorted();
      const group = files.filter((file) => file.includes(NEGATIVE_MARK) === negative);
      const keep = negative ? MAX_NEGATIVE_EXAMPLES : MAX_EXAMPLES;
      for (const old of group.slice(0, Math.max(0, group.length - keep))) rmSync(join(this.examplesDir, old), { force: true });
    } catch (err) {
      this.warn(`[surface] could not write an example: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The last `days` days of rows, today's in-memory counts included. */
  rows(days = SUMMARY_DAYS): CounterRow[] {
    this.roll();
    const earlier = readDays(this.dir, this.now(), days).filter((day) => day.date !== this.day.date);
    return summarize([...earlier, this.day]);
  }

  /** The totals of the last `days` days, for `/api/health`. */
  totals(days = SUMMARY_DAYS): SurfaceTotals {
    return totalsOf(this.rows(days));
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** A change was made: write now when the last write is old enough, else once, when it will be. */
  private touch(): void {
    this.dirty = true;
    const wait = this.lastWrite + this.writeEveryMs - this.now();
    if (wait <= 0) {
      this.write();
      return;
    }
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.write();
    }, wait);
  }

  /** Writes today's file now, when it changed. Never throws. */
  flush(): void {
    this.write();
  }

  private write(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastWrite = this.now();
    try {
      this.ensureDir();
      const target = counterPath(this.dir, this.day.date);
      const temp = `${target}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.day)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, target);
    } catch (err) {
      this.warn(`[surface] could not write the counters: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drops counters files older than {@link KEEP_DAYS} days, by the date in their name. */
  private prune(): void {
    try {
      if (!existsSync(this.dir)) return;
      const earliest = dayOf(this.now() - (KEEP_DAYS - 1) * 24 * 60 * 60 * 1000);
      for (const date of counterDates(readdirSync(this.dir))) {
        if (date < earliest) rmSync(counterPath(this.dir, date), { force: true });
      }
    } catch (err) {
      this.warn(`[surface] could not prune the counters: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
