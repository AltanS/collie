import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "./json.ts";

// The folders a new space was created in on THIS machine, and the ones the operator starred (#289,
// M40/02). The new-space sheet reads them so a phone taps a folder instead of typing a path.
//
// ── ONE LIST PER MACHINE, KEPT BY THAT MACHINE'S OWN BRIDGE ─────────────────────
// A folder exists on one machine only, so the list lives where the folder does: `folders.json` in
// this instance's state dir, `snooze.json`'s and `notify-prefs.json`'s sibling. Every device the
// operator uses therefore sees one list per machine, and a crew reaches a peer's list through the
// lead exactly as it reaches that peer's launcher rows (CREW_PROTOCOL.md §5). It is NOT in the
// snapshot: the sheet reads it when it opens and when the chosen machine changes.
//
// ── THE FILE IS WRITTEN BY TWO EVENTS, AND BY NOTHING ELSE ──────────────────────
// A space created with a folder (the bridge records it itself, from the folder the multiplexer
// reported), and a star or an unstar from the phone. A bridge that is only started, only read, or
// only ever asked for spaces in home writes no `folders.json` at all, which is what keeps
// `bridge/solo-baseline.test.ts`'s written-entries assertion at four (CREW_PROTOCOL.md §11).
//
// ── STRINGS, NEVER PATHS ────────────────────────────────────────────────────────
// Nothing here opens, stats or resolves a stored folder. The multiplexer reported it, the file holds
// it, the phone gets it back, and the only operations on it are string equality and one trailing
// slash dropped. A folder that no longer exists stays until newer ones push it out; a create there
// fails with the multiplexer's own words and records nothing. So CLAUDE.md's rule about client
// values becoming paths gains no third place: a starred string must already be in Recent, or be the
// folder one of this machine's panes reports right now ("Open now"), and both only ever hold what a
// multiplexer said.

/** Recent keeps the newest eight folders a space was created in. */
export const MAX_RECENT = 8;
/** Favourites keeps at most twelve, in the order they were starred. A thirteenth star is refused. */
export const MAX_FAVOURITES = 12;
/**
 * The longest folder string the file or the phone may carry. Linux's own `PATH_MAX`, so no real
 * folder is refused, and a body the phone sends cannot grow the file without bound.
 */
export const MAX_FOLDER_CHARS = 4096;

/** The two lists, newest first for Recent and in starred order for Favourites. Never overlapping. */
export interface FolderLists {
  recent: string[];
  favourites: string[];
}

/** Why a star was refused. Both are catalogued codes (`bridge/error-codes.ts`), answered as a 409. */
export type StarRefusal = "folders.unknown" | "folders.favourites_full";

/** A star or unstar, judged. `changed: false` is an answer, not a refusal: the list already says so. */
export type StarOutcome = { ok: true; lists: FolderLists; changed: boolean } | { ok: false; code: StarRefusal };

/**
 * What the routes and the space create need of the store. `bridge/server.ts` holds this, never the
 * class, so the HTTP layer cannot reach the file or its queue.
 */
export interface FolderSurface {
  /** This machine's home dir. Never an entry (a blank field already means home); the sheet shortens with it. */
  readonly home: string;
  /** A copy of both lists. */
  current(): FolderLists;
  /** Record a folder a space was just created in. Never throws: a failed write costs a Recent entry, not the create. */
  recordRecent(folder: string): Promise<void>;
  /**
   * Star (`true`) or unstar (`false`) one folder, and persist when that changed anything. `openNow` is
   * the folders this machine's panes report right now, as its multiplexer spelled them: a star may
   * name one of those as well as a Recent folder. Home and an empty report are never entries.
   */
  star(folder: string, starred: boolean, openNow?: readonly string[]): Promise<StarOutcome>;
}

/** One trailing slash dropped (never the root's), so `/srv/app/` and `/srv/app` are one entry. */
function trimSlash(folder: string): string {
  return folder.length > 1 && folder.endsWith("/") ? folder.slice(0, -1) : folder;
}

/**
 * `raw` as an entry, or `null` when it may not be one: not a string, empty, longer than
 * {@link MAX_FOLDER_CHARS}, or this machine's home.
 */
export function usableFolder(raw: JsonValue | undefined, home: string): string | null {
  if (typeof raw !== "string") return null;
  const folder = trimSlash(raw);
  if (folder === "" || folder.length > MAX_FOLDER_CHARS) return null;
  if (home !== "" && folder === trimSlash(home)) return null;
  return folder;
}

/** The strings of one array field, usable and first-seen only. A non-array is an empty list. */
function entriesOf(raw: JsonValue | undefined, home: string): string[] {
  return Array.isArray(raw) ? distinctEntries(raw, home) : [];
}

/** `items` as entries: usable ones only, first-seen only, in the order given. */
function distinctEntries(items: readonly JsonValue[], home: string): string[] {
  const out: string[] = [];
  for (const item of items) {
    const folder = usableFolder(item, home);
    if (folder !== null && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/**
 * Coerce an untrusted parsed file into the two lists. Pure and exported so the file-shape handling
 * is unit-testable, `coerceNotifyPrefs`'s sibling: a malformed file, a wrong type or a hand-edited
 * entry costs that entry, never the bridge.
 */
export function coerceFolderLists(raw: JsonValue | undefined, home: string): FolderLists {
  const o: JsonObject = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const favourites = entriesOf(o.favourites, home).slice(0, MAX_FAVOURITES);
  // A favourite is never listed again under Recent, whichever list the file put it in first.
  const recent = entriesOf(o.recent, home)
    .filter((f) => !favourites.includes(f))
    .slice(0, MAX_RECENT);
  return { recent, favourites };
}

/**
 * The lists after a space was created in `raw`, or `null` when nothing changes: an unusable folder
 * (home included), a folder already starred, or the folder already at the top of Recent.
 */
export function withRecent(lists: FolderLists, raw: string, home: string): FolderLists | null {
  const folder = usableFolder(raw, home);
  if (folder === null) return null;
  if (lists.favourites.includes(folder)) return null;
  if (lists.recent[0] === folder) return null;
  return {
    recent: [folder, ...lists.recent.filter((f) => f !== folder)].slice(0, MAX_RECENT),
    favourites: [...lists.favourites],
  };
}

/**
 * The lists after a star or an unstar.
 *
 * - **Star** a folder in Recent: it leaves Recent and joins the end of Favourites. A folder in
 *   `open`, the entries this machine's panes use right now, joins the end of Favourites the same
 *   way. Any other folder is refused (`folders.unknown`): only a folder a space already opened in,
 *   or one a pane sits in now, can be starred, which is #289's "by success only" applied to
 *   favourites. A thirteenth is refused too (`folders.favourites_full`) rather than dropping one the
 *   operator chose.
 * - **Unstar** a favourite: it goes to the top of Recent, so a mis-tapped star is one more tap to
 *   undo rather than a folder lost. That holds for a folder starred from Open now too: it was a
 *   folder a multiplexer reported, and Recent is where the sheet can reach it again.
 * - Starring a favourite, or unstarring a folder that is not one, changes nothing and is not an
 *   error: the list already says what the tap asked for (a second device may have got there first).
 */
export function withStar(
  lists: FolderLists,
  raw: string,
  starred: boolean,
  open: readonly string[] = [],
): StarOutcome {
  const folder = trimSlash(raw);
  const isFavourite = lists.favourites.includes(folder);
  if (starred) {
    if (isFavourite) return { ok: true, lists, changed: false };
    if (!lists.recent.includes(folder) && !open.includes(folder)) return { ok: false, code: "folders.unknown" };
    if (lists.favourites.length >= MAX_FAVOURITES) return { ok: false, code: "folders.favourites_full" };
    return {
      ok: true,
      changed: true,
      lists: { recent: lists.recent.filter((f) => f !== folder), favourites: [...lists.favourites, folder] },
    };
  }
  if (!isFavourite) return { ok: true, lists, changed: false };
  return {
    ok: true,
    changed: true,
    lists: {
      recent: [folder, ...lists.recent].slice(0, MAX_RECENT),
      favourites: lists.favourites.filter((f) => f !== folder),
    },
  };
}

function copyOf(lists: FolderLists): FolderLists {
  return { recent: [...lists.recent], favourites: [...lists.favourites] };
}

export class FolderStore implements FolderSurface {
  private lists: FolderLists = { recent: [], favourites: [] };
  private readonly file: string;
  private readonly stateDir: string;
  /** Saves run one after another, so two quick taps never race one temp file into two renames. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    cfg: { stateDir: string },
    readonly home: string = homedir(),
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {
    this.stateDir = cfg.stateDir;
    this.file = join(cfg.stateDir, "folders.json");
  }

  async load(): Promise<void> {
    try {
      this.lists = coerceFolderLists(await Bun.file(this.file).json(), this.home);
    } catch {
      /* nothing recorded yet, or a file that is not JSON — and asking must not create the file */
    }
  }

  current(): FolderLists {
    return copyOf(this.lists);
  }

  async recordRecent(folder: string): Promise<void> {
    const next = withRecent(this.lists, folder, this.home);
    if (next === null) return;
    this.lists = next;
    try {
      await this.save();
    } catch (err) {
      // The space exists; the list is a convenience. The entry stays in memory and reaches disk with
      // the next write that succeeds.
      this.warn(`[folders] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async star(folder: string, starred: boolean, openNow: readonly string[] = []): Promise<StarOutcome> {
    // Held to the same rules as a stored entry, so home and an empty report can never be starred.
    const outcome = withStar(this.lists, folder, starred, distinctEntries(openNow, this.home));
    if (!outcome.ok || !outcome.changed) return outcome;
    const before = this.lists;
    this.lists = outcome.lists;
    try {
      await this.save();
    } catch (err) {
      // A star the disk refused is not a star: put the lists back so what the phone reads next is
      // what the file holds, and let the route answer the failure.
      this.lists = before;
      throw err;
    }
    return { ok: true, lists: copyOf(this.lists), changed: true };
  }

  /** Queue one write of whatever the lists hold when its turn comes. */
  private save(): Promise<void> {
    const run = this.queue.then(() => this.write());
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Atomic, owner-only write: a fresh temp file (mode 0600) renamed over the target, as
   * `notify-prefs.json` is written. The folders are STRINGS here: this writes them and never reads,
   * stats or resolves one as a path (see the header).
   */
  private async write(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.lists, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
