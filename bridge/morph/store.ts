// Morph's state, kept on the machine whose bridge took the show.
//
//   <stateDir>/morph/state.json
//   { "v": 1, "sessions": [ { "session", "on", "view"?, "drawing"? }, ... ] }
//
// One entry per session, keyed by the session's walky address with its instance token (the key the
// hill names a session with), so a new session in a reused pane starts with Morph off and no screen.
// The folder is 0700 and the file 0600, written whole to a temp file and renamed over the old one, as
// the hill's store does. Nothing else in the state dir changes shape, and a bridge that never saw a
// Morph switch or show never makes the folder.
//
// THE REVISION rides on the snapshot as `morphRev` and on `GET /api/morph` as `rev`. It starts at the
// clock when the file is read at boot and moves on every write. Undefined until the file exists, so a
// bridge that never used Morph serves the same snapshot bytes as a build without it.
//
// A FILE THAT DOES NOT READ is set aside as `state.json.bad-<ms>` and the store starts empty, with one
// warning. An entry this build cannot read is dropped: Morph holds nothing worth keeping across a
// rollback, a screen is redrawn by the next answer.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import type { JsonValue } from "../json.ts";
import { MORPH_SESSION_MAX, readMorphDrawing, readMorphView, type MorphDrawing, type MorphView } from "../../web/src/lib/morph/wire.ts";

/** Morph's folder inside a state dir. */
export function morphDir(stateDir: string): string {
  return join(stateDir, "morph");
}

/** The state file's name inside the Morph folder. */
export const MORPH_STATE_FILE = "state.json";

/** The most sessions the file keeps. Past it, the entries changed longest ago go first. */
export const MORPH_SESSIONS_KEPT = 64;

/** One session as the store holds it. `changedAt` orders the cap; it is never served. */
export interface MorphEntry {
  readonly session: string;
  readonly on: boolean;
  readonly view?: MorphView;
  /** The agent's `morph start`, until a show, a clear, the switch going off, or ten minutes. An older build ignores the field. */
  readonly drawing?: MorphDrawing;
  /** How many shows this session took: the next show's `rev` is one more, even after a clear. */
  readonly shows: number;
  readonly changedAt: number;
}

function count(value: JsonValue | undefined): number {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function readEntry(raw: JsonValue): MorphEntry | null {
  const obj = asJsonObject(raw);
  if (obj === undefined) return null;
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  const changedAt = count(obj.changedAt);
  if (session === undefined || session === "" || session.length > MORPH_SESSION_MAX || on === undefined) return null;
  const view = obj.view === undefined ? null : readMorphView(obj.view);
  // A view's rev never falls below the count: a hand-edited count cannot make the next show go back.
  const shows = Math.max(count(obj.shows), view?.rev ?? 0);
  const drawing = obj.drawing === undefined ? null : readMorphDrawing(obj.drawing);
  return morphEntry({ session, on, shows, changedAt, view: view ?? undefined, drawing: drawing ?? undefined });
}

/** One entry built from its parts: `view` and `drawing` are on it only when given. */
export function morphEntry(parts: {
  session: string;
  on: boolean;
  shows: number;
  changedAt: number;
  view: MorphView | undefined;
  drawing: MorphDrawing | undefined;
}): MorphEntry {
  const { view, drawing } = parts;
  const base = { session: parts.session, on: parts.on, shows: parts.shows, changedAt: parts.changedAt };
  if (view !== undefined && drawing !== undefined) return { ...base, view, drawing };
  if (view !== undefined) return { ...base, view };
  if (drawing !== undefined) return { ...base, drawing };
  return base;
}

/** The entries to keep: the newest {@link MORPH_SESSIONS_KEPT} by last change, in their held order. */
export function capped(entries: readonly MorphEntry[], keep = MORPH_SESSIONS_KEPT): MorphEntry[] {
  if (entries.length <= keep) return [...entries];
  const kept = new Set(
    entries
      .toSorted((a, b) => b.changedAt - a.changedAt)
      .slice(0, keep)
      .map((entry) => entry.session),
  );
  return entries.filter((entry) => kept.has(entry.session));
}

export class MorphStore {
  private entries: MorphEntry[] = [];
  private revision: number | undefined;
  private readonly path: string | null;

  /** `dir` null keeps the state in memory only (a test); the revision still moves. */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.path = dir === null ? null : join(dir, MORPH_STATE_FILE);
    this.load();
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    const raw = this.readText(this.path);
    const file = raw === null ? undefined : parseJsonObject(raw);
    if (file?.v !== 1 || !Array.isArray(file.sessions)) {
      this.setAside(this.path);
      return;
    }
    const read: MorphEntry[] = [];
    for (const value of file.sessions) {
      const entry = readEntry(value);
      if (entry !== null && !read.some((held) => held.session === entry.session)) read.push(entry);
    }
    this.entries = read;
    this.revision = this.now();
  }

  private readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  private setAside(path: string): void {
    const aside = `${path}.bad-${String(this.now())}`;
    try {
      renameSync(path, aside);
      this.warn(`[morph] ${path} did not read; set aside as ${aside}, starting empty`);
    } catch (err) {
      this.warn(`[morph] ${path} did not read and could not be set aside: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The revision, or undefined while no state file exists. */
  rev(): number | undefined {
    return this.revision;
  }

  /** One session's entry. */
  get(session: string): MorphEntry | undefined {
    return this.entries.find((entry) => entry.session === session);
  }

  /** Every entry held, in held order. */
  all(): readonly MorphEntry[] {
    return this.entries;
  }

  /**
   * Replace the whole list in one write: the caller computes the next list from {@link all}. False when
   * the write failed: memory stays as it was, so nothing is claimed that a restart would lose.
   */
  replace(next: readonly MorphEntry[]): boolean {
    const kept = capped(next);
    if (!this.write(kept)) return false;
    this.entries = kept;
    this.revision = Math.max((this.revision ?? 0) + 1, this.now());
    return true;
  }

  private write(entries: readonly MorphEntry[]): boolean {
    if (this.path === null || this.dir === null) return true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, sessions: entries })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
      return true;
    } catch (err) {
      this.warn(`[morph] could not save ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
