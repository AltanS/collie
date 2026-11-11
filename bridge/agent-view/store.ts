// The agent views' state, kept on the machine whose bridge took the write.
//
//   <stateDir>/trick-views/views/<key>.json     one file per (trick, session), folder 0700, file 0600
//   { "v": 1, "trick", "session", "on", "shows", "changedAt", "view"?, "drawing"?, "mark"?, "staleTurn"?, "sent"? }
//
// ONE FILE PER VIEW. A write rewrites the one view it changed, never the others (agent views SECURITY N7):
// `<key>` is the first 32 hex characters of the SHA-256 of `<trick>\0<session>`, so neither the trick id
// nor the address is a path. Each file is written whole to a temp file and renamed over the old one, as the
// hill's store does. A bridge that never saw a view switched on never makes the folder.
//
// THE REVISION rides on the snapshot as `trickViewsRev` and on `GET /api/trick-views` as `rev`. It starts
// at the clock when the folder is read at boot and moves on every write and every `touch`. Each view also
// holds the revision of its own last change, so a read `?since=<rev>` answers only the views that moved
// (bridge/agent-view/service.ts). Every view read at boot takes the boot revision: the first read after a
// restart serves them all once.
//
// A FILE THAT DOES NOT READ is set aside as `<key>.json.bad-<ms>` with one warning, and the view is gone.
// A view holds nothing worth keeping across a rollback: a screen is redrawn by the next answer.
//
// NO MIGRATION of `<stateDir>/morph/`: native Morph never shipped. A stale folder of a development build
// is left alone; nothing reads it.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import type { JsonValue } from "../json.ts";
import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { readViewDrawing, readViewScreen, readViewSentList, VIEW_SESSION_MAX, type ViewDrawing, type ViewScreen, type ViewSent } from "../../web/src/lib/agent-view/wire.ts";

/** The agent views' folder inside a state dir. Its `media/` holds the pictures (bridge/agent-view/media.ts). */
export function trickViewsDir(stateDir: string): string {
  return join(stateDir, "trick-views");
}

/** The folder of the view files inside {@link trickViewsDir}. */
export const VIEWS_FOLDER = "views";

/** The most views the folder keeps. Past it, the views changed longest ago go first. */
export const VIEWS_KEPT = 64;

/** The longest pane mark a view keeps (bridge/agent-view/mark.ts): a harness id and a conversation id. */
const MARK_MAX = 600;

/** One view as the store holds it. `changedAt` orders the cap; it is never served. */
export interface ViewEntry {
  readonly trick: string;
  readonly session: string;
  /** The person's switch, from the phone. Only the person switches a view (agent views N9). */
  readonly on: boolean;
  readonly view?: ViewScreen;
  /** The agent's `start`, until a show, a clear, the switch going off, or ten minutes. */
  readonly drawing?: ViewDrawing;
  /** How many screens this view took: the next write's `rev` is one more, even after a clear. */
  readonly shows: number;
  readonly changedAt: number;
  /** The pane's mark when the screen was written (harness and conversation): another mark now makes it stale. */
  readonly mark?: string;
  /** A person turn that did not come from the view reached a pane whose harness reports no conversation. */
  readonly staleTurn?: true;
  /** The lines the bridge typed for this view, newest last. */
  readonly sent?: readonly ViewSent[];
}

/** A view's key in memory: the trick and the session, joined by a NUL neither can hold. */
export function viewKey(trick: string, session: string): string {
  return `${trick}\u0000${session}`;
}

/** A view's file name: 32 hex characters of the key's SHA-256, never the key itself. */
export function viewFileName(trick: string, session: string): string {
  return `${createHash("sha256").update(viewKey(trick, session)).digest("hex").slice(0, 32)}.json`;
}

function count(value: JsonValue | undefined): number {
  const n = asJsonNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function readEntry(raw: JsonValue): ViewEntry | null {
  const obj = asJsonObject(raw);
  if (obj?.v !== 1) return null;
  const trick = asJsonString(obj.trick);
  const session = asJsonString(obj.session);
  const on = asJsonBoolean(obj.on);
  if (trick === undefined || !isTrickId(trick) || session === undefined || session === "" || session.length > VIEW_SESSION_MAX || on === undefined) return null;
  const view = obj.view === undefined ? null : readViewScreen(obj.view);
  // A screen's rev never falls below the count: a hand-edited count cannot make the next write go back.
  const shows = Math.max(count(obj.shows), view?.rev ?? 0);
  const drawing = obj.drawing === undefined ? null : readViewDrawing(obj.drawing);
  const mark = asJsonString(obj.mark);
  const sent = readViewSentList(obj.sent);
  return viewEntry({
    trick,
    session,
    on,
    shows,
    changedAt: count(obj.changedAt),
    view: view ?? undefined,
    drawing: drawing ?? undefined,
    mark: mark !== undefined && mark.length <= MARK_MAX ? mark : undefined,
    staleTurn: obj.staleTurn === true,
    sent,
  });
}

/** One entry built from its parts: each optional part is on it only when given. */
export function viewEntry(parts: {
  trick: string;
  session: string;
  on: boolean;
  shows: number;
  changedAt: number;
  view?: ViewScreen | undefined;
  drawing?: ViewDrawing | undefined;
  mark?: string | undefined;
  staleTurn?: boolean | undefined;
  sent?: readonly ViewSent[] | undefined;
}): ViewEntry {
  let out: ViewEntry = { trick: parts.trick, session: parts.session, on: parts.on, shows: parts.shows, changedAt: parts.changedAt };
  if (parts.view !== undefined) out = { ...out, view: parts.view };
  if (parts.drawing !== undefined) out = { ...out, drawing: parts.drawing };
  if (parts.view !== undefined && parts.mark !== undefined) out = { ...out, mark: parts.mark };
  if (parts.view !== undefined && parts.staleTurn === true) out = { ...out, staleTurn: true };
  if (parts.sent !== undefined && parts.sent.length > 0) out = { ...out, sent: [...parts.sent] };
  return out;
}

/** One view in memory: the entry and the revision of its last change. */
interface Held {
  entry: ViewEntry;
  rev: number;
}

export class AgentViewStore {
  private readonly held = new Map<string, Held>();
  private revision: number | undefined;
  private readonly folder: string | null;

  /** `dir` null keeps the state in memory only (a test); the revision still moves. */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.folder = dir === null ? null : join(dir, VIEWS_FOLDER);
    this.load();
  }

  private load(): void {
    if (this.folder === null || !existsSync(this.folder)) return;
    const rev = this.now();
    let names: string[];
    try {
      names = readdirSync(this.folder).filter((name) => /^[0-9a-f]{32}\.json$/u.test(name));
    } catch (err) {
      this.warn(`[trick-views] ${this.folder} could not be listed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const name of names) {
      const path = join(this.folder, name);
      const raw = this.readText(path);
      const entry = raw === null ? null : readEntry(parseJsonObject(raw) ?? null);
      // A file under another view's name (a hand edit) reads as no view.
      if (entry === null || viewFileName(entry.trick, entry.session) !== name) {
        this.setAside(path);
        continue;
      }
      this.held.set(viewKey(entry.trick, entry.session), { entry, rev });
    }
    this.revision = rev;
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
      this.warn(`[trick-views] ${path} did not read; set aside as ${aside}`);
    } catch (err) {
      this.warn(`[trick-views] ${path} did not read and could not be set aside: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The revision, or undefined while no view was ever written. */
  rev(): number | undefined {
    return this.revision;
  }

  /** One view's entry. */
  get(trick: string, session: string): ViewEntry | undefined {
    return this.held.get(viewKey(trick, session))?.entry;
  }

  /** The revision of one view's last change, or undefined when the store holds no such view. */
  revOf(trick: string, session: string): number | undefined {
    return this.held.get(viewKey(trick, session))?.rev;
  }

  /** Every view held, in held order. */
  all(): ViewEntry[] {
    return [...this.held.values()].map((held) => held.entry);
  }

  private bump(): number {
    this.revision = Math.max((this.revision ?? 0) + 1, this.now());
    return this.revision;
  }

  /**
   * Write one view. False when the write failed: memory stays as it was, so nothing is claimed that a
   * restart would lose. Past {@link VIEWS_KEPT}, the views changed longest ago go, file and all.
   */
  put(entry: ViewEntry): boolean {
    if (!this.write(entry)) return false;
    const rev = this.bump();
    this.held.set(viewKey(entry.trick, entry.session), { entry, rev });
    this.cap();
    return true;
  }

  /** Remove one view, file and all. False when the file could not be removed. */
  drop(trick: string, session: string): boolean {
    const key = viewKey(trick, session);
    if (!this.held.has(key)) return true;
    if (!this.unlink(trick, session)) return false;
    this.held.delete(key);
    this.bump();
    return true;
  }

  /**
   * Move one view's revision without a write: something the phone reads beside the entry changed (its
   * rules proof, its gate, a stale mark, a question on screen), so a `since` read must serve it again.
   */
  touch(trick: string, session: string): void {
    const held = this.held.get(viewKey(trick, session));
    if (held === undefined) return;
    held.rev = this.bump();
  }

  private cap(): void {
    if (this.held.size <= VIEWS_KEPT) return;
    const oldest = [...this.held.values()].toSorted((a, b) => a.entry.changedAt - b.entry.changedAt).slice(0, this.held.size - VIEWS_KEPT);
    for (const held of oldest) {
      if (this.unlink(held.entry.trick, held.entry.session)) this.held.delete(viewKey(held.entry.trick, held.entry.session));
    }
  }

  private unlink(trick: string, session: string): boolean {
    if (this.folder === null) return true;
    try {
      rmSync(join(this.folder, viewFileName(trick, session)), { force: true });
      return true;
    } catch (err) {
      this.warn(`[trick-views] could not remove a view of ${trick}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private write(entry: ViewEntry): boolean {
    if (this.folder === null || this.dir === null) return true;
    const path = join(this.folder, viewFileName(entry.trick, entry.session));
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      chmodSync(this.folder, 0o700);
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, ...entry })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
      return true;
    } catch (err) {
      this.warn(`[trick-views] could not save ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
