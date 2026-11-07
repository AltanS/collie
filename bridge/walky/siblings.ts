// The walky talky rows a SIBLING instance recorded (fixed 2026-11-07). Two Collie instances on one
// machine can share one multiplexer: the release lane and a dev lane both watch the same panes. An
// agent's `collie walky send` reaches the bridge whose binary is on its PATH, which records and types
// the message; the other bridge sees the typed line in the same pane and holds no record of it, so the
// phone looking at that bridge marked the id "no log record on this machine" and drew no card.
//
// So a bridge that answers a pane's list also reads what its live siblings recorded for that pane.
//
//   Who is a sibling   every bridge in the hook target registry (bridge/beacon/hook-targets.ts) whose
//                      pid still runs, minus this bridge's own state dir by real path. No scan of the
//                      state folders and no guessed names: a registry that is missing or not private
//                      reads as no siblings, and the list is then exactly this bridge's own.
//   What is read       `<stateDir>/walky/log.jsonl` and `<stateDir>/walky/instances.json`, never
//                      written. A sibling's WalkyLog would rotate the file and prune its inboxes, so
//                      the log is parsed with `recordsOfText` (log.ts), the same line reader, instead.
//   What counts        {@link siblingPlacementCounts}: the sibling gives the same pane its own token,
//                      so a row counts when its session and pane id match and its token is the
//                      sibling's CURRENT token for that pane, or the row predates tokens.
//   What it costs      a pane polls its list every few seconds. Each file is cached by (path, mtime,
//                      size) and re-read only when either changed, so a quiet sibling costs two stats a
//                      poll. A read takes at most the newest {@link SIBLING_READ_MAX_BYTES}, and of
//                      those the newest LOG_MAX_LINES lines. The registry walk is cached for
//                      {@link SIBLING_DIRS_TTL_MS}.
//
// Each row carries `recordedBy` (the sibling's state dir name) and `recordedAs` (this pane's address in
// the sibling's words, which carries the sibling's member id): the phone reads direction and machine
// against that address (web/src/lib/walky.ts `selfOf`).

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { bareAddress, INSTANCE_TOKEN } from "./address.ts";
import { LOG_MAX_LINES, recordsOfText, type LogRecord, type Placement, type SiblingRow, type SiblingSource } from "./log.ts";

/** The most bytes read off the end of one sibling file. A log that keeps its cap is well under it. */
export const SIBLING_READ_MAX_BYTES = 8 * 1024 * 1024;
/** How long one walk of the hook target registry stands. */
export const SIBLING_DIRS_TTL_MS = 5_000;

/** One live sibling: its state dir and the name its rows carry. */
export interface SiblingDir {
  readonly stateDir: string;
  /** The last segment of the state dir, as it is: `collie`, `collie-next`. */
  readonly name: string;
}

/**
 * Whether a sibling's placement (a record's target, or its sender) counts for this pane. The session
 * and the pane id must match. A placement with no token predates tokens and counts; one with a token
 * counts only when it is the sibling's current token for the pane (`current`), so a row of a pane that
 * was replaced, an old token, does not. A sibling that holds no token for the pane counts only the
 * rows from before tokens.
 */
export function siblingPlacementCounts(place: Placement | null, session: string, paneId: string, current: string | null): boolean {
  if (place === null || place.session !== session || place.paneId !== paneId) return false;
  if (place.instance === null) return true;
  return current !== null && place.instance === current;
}

function paneKey(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

/** A sibling's `instances.json` as (session, pane id) to token. A file that does not parse is empty. */
export function instanceTokensOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const row = parseJsonObject(text);
  if (row?.v !== 1 || !Array.isArray(row.panes)) return out;
  for (const value of row.panes) {
    const entry = asJsonObject(value);
    const session = asJsonString(entry?.session);
    const paneId = asJsonString(entry?.paneId);
    const token = asJsonString(entry?.token);
    if (session === undefined || paneId === undefined || token === undefined || !INSTANCE_TOKEN.test(token)) continue;
    out.set(paneKey(session, paneId), token);
  }
  return out;
}

/**
 * The live siblings out of the registry's live records: every state dir but this bridge's own, compared
 * by real path, each once. `realpath` answers null for a dir it cannot resolve, which then compares as given.
 */
export function siblingDirsOf(targets: readonly { readonly stateDir: string }[], ownStateDir: string, realpath: (path: string) => string | null): SiblingDir[] {
  const own = realpath(ownStateDir) ?? ownStateDir;
  const seen = new Set<string>([own]);
  const out: SiblingDir[] = [];
  for (const target of targets) {
    const real = realpath(target.stateDir) ?? target.stateDir;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ stateDir: target.stateDir, name: basename(target.stateDir) });
  }
  return out;
}

/** What the reader needs of the disk. A seam so a test can count the reads. */
export interface SiblingFs {
  /** A regular file's mtime and size, or null when it is missing or cannot be read. */
  stat(path: string): { readonly mtimeMs: number; readonly size: number } | null;
  /** The file's text, at most `maxBytes` off its end with a cut first line dropped, or null. */
  readTail(path: string, maxBytes: number): string | null;
}

export const realSiblingFs: SiblingFs = {
  stat(path) {
    try {
      const stat = statSync(path);
      return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
    } catch {
      return null;
    }
  },
  readTail(path, maxBytes) {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      const got = readSync(fd, buffer, 0, length, size - length);
      const text = buffer.subarray(0, got).toString("utf8");
      // Read from the middle of the file: the first line is cut, so it goes.
      return length < size ? text.slice(text.indexOf("\n") + 1) : text;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },
};

interface Cached<T> {
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: T;
}

export interface SiblingLogsDeps {
  /** The live siblings, this bridge excluded ({@link siblingDirsOf}). Called at most every {@link SIBLING_DIRS_TTL_MS}. */
  readonly dirs: () => readonly SiblingDir[];
  readonly fs?: SiblingFs;
  readonly now?: () => number;
}

/** The rows every live sibling recorded for a pane, read-only and cached. The log's {@link SiblingSource}. */
export class SiblingLogs implements SiblingSource {
  private readonly fs: SiblingFs;
  private readonly now: () => number;
  private readonly logs = new Map<string, Cached<readonly LogRecord[]>>();
  private readonly tokens = new Map<string, Cached<ReadonlyMap<string, string>>>();
  private walked: { readonly at: number; readonly dirs: readonly SiblingDir[] } | null = null;
  /** How many files were read off the disk, for a test. */
  reads = 0;

  constructor(private readonly deps: SiblingLogsDeps) {
    this.fs = deps.fs ?? realSiblingFs;
    this.now = deps.now ?? Date.now;
  }

  private siblings(): readonly SiblingDir[] {
    const at = this.now();
    if (this.walked !== null && at - this.walked.at < SIBLING_DIRS_TTL_MS) return this.walked.dirs;
    let dirs: readonly SiblingDir[];
    try {
      dirs = this.deps.dirs();
    } catch {
      dirs = [];
    }
    this.walked = { at, dirs };
    return dirs;
  }

  /** A file through its cache: re-read only when its mtime or size moved. Missing or unreadable is null. */
  private cached<T>(cache: Map<string, Cached<T>>, path: string, parse: (text: string) => T): T | null {
    const stat = this.fs.stat(path);
    if (stat === null) {
      cache.delete(path);
      return null;
    }
    const held = cache.get(path);
    if (held !== undefined && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.value;
    const text = this.fs.readTail(path, SIBLING_READ_MAX_BYTES);
    this.reads += 1;
    if (text === null) {
      cache.delete(path);
      return null;
    }
    const value = parse(text);
    cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  /** One sibling's rows for the pane, newest first, at most `limit`. */
  private rowsOf(dir: SiblingDir, session: string, paneId: string, limit: number, sent: boolean): SiblingRow[] {
    const walky = join(dir.stateDir, "walky");
    const records = this.cached(this.logs, join(walky, "log.jsonl"), (text) => recordsOfText(text, LOG_MAX_LINES));
    if (records === null || records.length === 0) return [];
    const current = this.cached(this.tokens, join(walky, "instances.json"), instanceTokensOf)?.get(paneKey(session, paneId)) ?? null;
    const out: SiblingRow[] = [];
    for (const record of records.toReversed()) {
      if (out.length >= limit) break;
      const received = siblingPlacementCounts(record, session, paneId, current);
      if (!received && !(sent && siblingPlacementCounts(record.sender, session, paneId, current))) continue;
      const recordedAs = bareAddress(received ? record.target : (record.message.from.address ?? record.target));
      out.push({ entry: { ...record.message, receipt: record.receipt, recordedBy: dir.name, recordedAs }, acceptedAt: record.acceptedAt });
    }
    return out;
  }

  forPane(session: string, paneId: string, limit: number, sent: boolean): SiblingRow[] {
    const rows: SiblingRow[] = [];
    for (const dir of this.siblings()) {
      try {
        rows.push(...this.rowsOf(dir, session, paneId, limit, sent));
      } catch {
        // A sibling whose files cannot be read adds nothing; the own list still answers.
      }
    }
    // Newest first across the siblings; the sort is stable, so each sibling keeps its own order.
    return rows.toSorted((a, b) => b.acceptedAt - a.acceptedAt).slice(0, limit);
  }
}
