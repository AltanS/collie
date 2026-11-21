import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { commitAside, finishAside, moveAside, newAsideToken, putBack, type Moved } from "./aside.ts";
import { APPROVED_DIR, PENDING_DIR, tricksConfigDir, tricksStateDir } from "./paths.ts";
import { readSwitchesNow, withSwitchLock } from "./switches.ts";

// REMOVING A TRICK (ADR 0168): the one function `collie trick remove <id>` and the bridge route
// `POST /api/tricks/<host>/<id>/remove` both call. What remove means lives here and nowhere else.
//
// WHAT GOES: the trick's folder `<configDir>/tricks/<id>/`, its state folder `<stateDir>/tricks/<id>/`, and its
// approved and pending copies `<configDir>/tricks/.collie-approved/<id>/` and `.collie-pending/<id>/`. Then the
// caller's `forget` drops what lives beside the files: the agent views and the Hill keys of the id (the bridge
// hands its live stores, the terminal a disk-only forget). Nothing else is touched: not another trick, not the
// switch file, not a shared cache. A trick whose folder is gone but whose other places are there (an older crash,
// a folder deleted by hand) is removed the same way: its leftovers go.
//
// THE ID IS A NAME, NEVER A PATH. `id` must pass `isTrickId` (lower-case letters, digits and `-`; no dot, no slash),
// so `..`, an absolute path and an encoded slash are refused before any path is built. Each of the four places that
// is there must be a real folder whose real path is exactly `<real base>/<id>`: a link or a file in its place, or a
// base folder that is a link pointing elsewhere, refuses the whole remove and nothing is moved.
//
// ONLY WHILE IT IS OFF, AND WITH NO RUN GOING. The check is made twice, the second time INSIDE the switch file's lock
// (switches.ts `withSwitchLock`): a switch on (the phone's, the terminal's) writes under the same lock and checks
// that the folder is still there (`updateSwitchesFor`), so it lands before the check or finds the folder gone. A
// switch file that cannot be read as switches REFUSES the remove (it is never read as "off", never rewritten). A run
// of a trick reads the switch file again before its program starts (service.ts `recheck`), after it marked itself
// busy, so a run that begins after the check sees the trick off and starts nothing.
//
// ONE COMMIT POINT (aside.ts). Inside the lock the places are only RENAMED aside, the trick's own folder LAST, so
// that until the commit the trick is still listed; then the batch is committed (one synced file). Before the commit
// any failure puts every place back. After it the answer is "removed" whatever happens next: `forget` and each delete
// run on their own, a failure is logged and answered as a leftover, and the bridge's next start finishes it.

/** What the app and the command say while a run of the trick is going, queued or waiting to deliver an answer. */
export const REMOVE_RUNNING_LINE = "A run of this trick is still going. Try again in a few seconds.";
/** What the app says for a trick that is on. The command prints its own line, which names `collie trick off`. */
export const REMOVE_ON_LINE = "Switch the trick off to remove it.";
/** What is said when a place is a link or a file, or its real path lies outside the tricks folders. */
export const REMOVE_LINK_LINE = "A folder of this trick is a link or lies outside the tricks folder, so nothing was removed. Look at it on the machine.";

/** Why a remove was refused. `unknown-trick`: none of its places is there; nothing else is told. */
export type RemoveRefusal = "unknown-trick" | "on" | "running" | "link";

export type RemoveResult =
  | {
      ok: true;
      folder: string;
      state: string;
      /** Asides still on disk after the commit (each logged); the next start deletes them. */
      leftovers: string[];
      /** False when `forget` threw (logged): the bridge's scan drops what it kept (service.ts `pruneAbsent`). */
      forgot: boolean;
    }
  | { ok: false; code: RemoveRefusal; message: string };

/** Thrown when the switch file cannot be read as switches: nothing was moved. */
export class RemoveUnreadable extends Error {}

export interface RemoveOptions {
  configDir: string;
  stateDir: string;
  id: string;
  /** Whether a run of the trick is going, queued or waiting to deliver an answer. Asked inside the switch file's lock. */
  busy: (id: string) => boolean;
  /** Drop what lives beside the files (agent views, Hill keys). Runs after the commit and the unlock, before the deletes. */
  forget?: (id: string) => void | Promise<void>;
  warn?: (line: string) => void;
  /** The commit step (aside.ts `commitAside`). A seam for a test that fails it. */
  commit?: (stateDir: string, id: string, token: string) => Promise<void>;
}

/** One of the four places, and the real path it must have: the real path of `root`, then `sub`, then the id. */
interface Place {
  path: string;
  /** The folder resolved: the tricks folder, or the state folder's `tricks/` (it may live on another disk). */
  root: string;
  /** The folder inside `root`, never resolved on its own: a `.collie-approved` that is a link is refused. */
  sub: string;
}

/** The trick's own folder, and the three places beside it: its state folder, its approved and its pending copies. */
interface Places {
  folder: Place;
  rest: Place[];
}

function placesOf(configDir: string, stateDir: string, id: string): Places {
  const root = tricksConfigDir(configDir);
  return {
    folder: { path: join(root, id), root, sub: "" },
    rest: [
      { path: join(tricksStateDir(stateDir), id), root: tricksStateDir(stateDir), sub: "" },
      { path: join(root, APPROVED_DIR, id), root, sub: APPROVED_DIR },
      { path: join(root, PENDING_DIR, id), root, sub: PENDING_DIR },
    ],
  };
}

type PlaceState = "absent" | "ok" | "bad";

/** `absent`, `ok`, or `bad` (a link or a file in its place, or a real path outside its base). Never throws. */
async function placeState(place: Place, id: string): Promise<PlaceState> {
  const st = await lstat(place.path).catch(() => null);
  if (st === null) return "absent";
  if (!st.isDirectory()) return "bad";
  const realRoot = await realpath(place.root).catch(() => null);
  const real = await realpath(place.path).catch(() => null);
  return realRoot !== null && real === join(realRoot, place.sub, id) ? "ok" : "bad";
}

/** Every place checked: none there (`absent`), any one a link or outside its base (`bad`), else the ones there. */
async function checkPlaces(configDir: string, stateDir: string, id: string): Promise<{ kind: "absent" } | { kind: "bad" } | { kind: "ok"; there: Set<string> }> {
  const { folder, rest } = placesOf(configDir, stateDir, id);
  const all = [folder, ...rest];
  const states = await Promise.all(all.map((place) => placeState(place, id)));
  if (states.includes("bad")) return { kind: "bad" };
  const there = new Set(all.filter((_, n) => states[n] === "ok").map((place) => place.path));
  return there.size === 0 ? { kind: "absent" } : { kind: "ok", there };
}

/**
 * Remove one trick: refused for an id that is no trick id or has none of its places, for a trick that is on or has
 * a run going, and for a place that is a link or lies outside the tricks folders. Each refusal moves nothing. Throws
 * {@link RemoveUnreadable} for a switch file that is not switches, and the error of a rename or of the commit after
 * every place was put back (a place that could not go back is named in it): in both cases nothing was removed.
 */
export async function removeTrick(opts: RemoveOptions): Promise<RemoveResult> {
  const { configDir, stateDir, id } = opts;
  const warn = opts.warn ?? ((line: string) => console.warn(`[tricks] ${line}`));
  if (!isTrickId(id)) return { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
  const before = await checkPlaces(configDir, stateDir, id);
  if (before.kind === "absent") return { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
  if (before.kind === "bad") return { ok: false, code: "link", message: REMOVE_LINK_LINE };
  const { folder, rest } = placesOf(configDir, stateDir, id);
  const token = newAsideToken();
  const moved: Moved[] = [];
  const refusal = await withSwitchLock(stateDir, async (): Promise<RemoveResult | null> => {
    const read = await readSwitchesNow(stateDir);
    if (read.problem !== null) throw new RemoveUnreadable(`${read.problem}, so nothing was removed`);
    // Asked again under the lock: a place that went or became a link, a switch on, a run that began.
    const held = await checkPlaces(configDir, stateDir, id);
    if (held.kind === "absent") return { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
    if (held.kind === "bad") return { ok: false, code: "link", message: REMOVE_LINK_LINE };
    if (read.switches.on.has(id)) return { ok: false, code: "on", message: REMOVE_ON_LINE };
    if (opts.busy(id)) return { ok: false, code: "running", message: REMOVE_RUNNING_LINE };
    try {
      // The trick's own folder last: until the commit it is still a listed trick.
      for (const place of [...rest, folder]) {
        if (!held.there.has(place.path)) continue;
        const to = await moveAside(place.path, id, token);
        if (to !== null) moved.push({ from: place.path, to });
      }
      // No switch write: an off trick has no entry (asked above). The file holds `v`, `layout` and `on` only
      // (switches.ts `renderSwitches`); `on` is the one field keyed by a trick id, and an entry in it IS "on"
      // (`withSwitch(..., false)` deletes it; the service reads on as `switches.on.has(id)`). Its `declined`,
      // `auto`, `previous` and `from` live inside that entry, so an off trick holds none. The commit is the last
      // step inside the lock.
      await (opts.commit ?? commitAside)(stateDir, id, token);
    } catch (err) {
      const back = await putBack(moved, warn);
      moved.length = 0;
      throw back.length === 0 ? err : new Error(`${err instanceof Error ? err.message : String(err)}; ${back.join("; ")}`);
    }
    return null;
  });
  if (refusal !== null) return refusal;
  // Committed: removed, whatever follows. Each step runs on its own.
  let forgot = true;
  try {
    await opts.forget?.(id);
  } catch (err) {
    forgot = false;
    warn(`the views and Hill keys of the removed trick ${id} could not be forgotten: ${err instanceof Error ? err.message : String(err)}`);
  }
  const leftovers = await finishAside({ stateDir, id, token, paths: moved.map((one) => one.to), warn });
  return { ok: true, folder: folder.path, state: rest[0]!.path, leftovers, forgot };
}

// ── The run marks: what the terminal reads to know a run is going ─────────────────────────────────
// A running bridge knows its runs in memory; `collie trick remove` is another process. So the bridge writes one small
// file per trick while a run of it goes, `<stateDir>/tricks/.runs/<id>`, holding its pid and the start time, written
// synchronously before the run reads the switch file again (`recheck`) and removed when the run ends. The terminal
// reads a mark as a run going while its pid lives and it is younger than {@link RUN_MARK_MAX_MS}; a mark a crash
// left is stale by its dead pid, and the bridge's start removes the folder. A trick's own program can remove a mark
// as it can any file of the user's: it gains nothing by that but its own removal mid-run.

/** The folder of run marks inside `<stateDir>/tricks/`. The dot keeps it apart from every trick id. */
export const RUNS_DIR = ".runs";
/** A mark older than this is stale whatever its pid says: a run ends in seconds, a pid can be reused. */
export const RUN_MARK_MAX_MS = 5 * 60 * 1000;

export function runMarkPath(stateDir: string, id: string): string {
  return join(tricksStateDir(stateDir), RUNS_DIR, id);
}

/** Mark a run of `id` as going. Synchronous, so nothing moves between the mark and what follows. Never throws. */
export function markRun(stateDir: string, id: string, now: number = Date.now()): void {
  if (!isTrickId(id)) return;
  try {
    mkdirSync(join(tricksStateDir(stateDir), RUNS_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(runMarkPath(stateDir, id), `${String(process.pid)} ${String(now)}\n`, { mode: 0o600 });
  } catch {
    // A mark that cannot be written costs the terminal's check, never the run: the bridge's own check is in memory.
  }
}

/** The run of `id` ended. Never throws. */
export function unmarkRun(stateDir: string, id: string): void {
  if (!isTrickId(id)) return;
  try {
    unlinkSync(runMarkPath(stateDir, id));
  } catch {
    // Gone already.
  }
}

/** Remove every mark: the bridge starts, so none of its runs is going. Never throws. */
export function clearRunMarks(stateDir: string): void {
  try {
    rmSync(join(tricksStateDir(stateDir), RUNS_DIR), { recursive: true, force: true });
  } catch {
    // A mark left is read by its pid and its age.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process lives, under another user.
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** Whether a bridge marked a run of `id` as going: a mark whose pid lives and that is younger than {@link RUN_MARK_MAX_MS}. */
export function runMarked(stateDir: string, id: string, now: number = Date.now()): boolean {
  if (!isTrickId(id)) return false;
  let text: string;
  try {
    text = readFileSync(runMarkPath(stateDir, id), "utf8");
  } catch {
    return false;
  }
  const match = /^(\d{1,10}) (\d{1,16})\n?$/u.exec(text);
  // A mark that does not read is taken as a run going while it is young (its file's age): the safe side of a remove.
  if (match === null) return now - (statSync(runMarkPath(stateDir, id), { throwIfNoEntry: false })?.mtimeMs ?? 0) < RUN_MARK_MAX_MS;
  const pid = Number(match[1]);
  const at = Number(match[2]);
  return now - at < RUN_MARK_MAX_MS && pidAlive(pid);
}
