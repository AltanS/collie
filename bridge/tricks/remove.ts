import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { moveAside, removeTree } from "./approved.ts";
import { APPROVED_DIR, PENDING_DIR, tricksConfigDir, tricksStateDir } from "./paths.ts";
import { updateSwitches } from "./switches.ts";

// REMOVING A TRICK (ADR 0168): the one function `collie trick remove <id>` and the bridge route
// `POST /api/tricks/<host>/<id>/remove` both call. What remove means lives here and nowhere else.
//
// WHAT GOES: the trick's folder `<configDir>/tricks/<id>/`, its state folder `<stateDir>/tricks/<id>/`, and its
// approved and pending copies `<configDir>/tricks/.collie-approved/<id>/` and `.collie-pending/<id>/`. Then the
// caller's `forget` drops what lives beside the files: the agent views and the Hill keys of the id (the bridge
// hands its live stores, the terminal a disk-only forget). Nothing else is touched: not another trick, not the
// switch file's other entries, not a shared cache.
//
// THE ID IS A NAME, NEVER A PATH. `id` must pass `isTrickId` (letters, digits, `-` and `_`; no dot, no slash), so
// `..`, an absolute path and an encoded slash are refused before any path is built. Each of the four places must
// then be a real folder whose real path is exactly `<real base>/<id>`: a link or a file in its place, or a base
// folder that is a link pointing elsewhere, refuses the whole remove and nothing is deleted.
//
// ONLY WHILE IT IS OFF, AND WITH NO RUN GOING. The check is made twice, the second time INSIDE the switch file's lock
// (switches.ts `updateSwitches`): a switch on (the phone's, the terminal's) writes under the same lock, so it lands
// before the check or after the remove, never in between. A run of a trick reads the switch file again before its
// program starts (service.ts `recheck`), after it marked itself busy, so a run that begins after the check sees the
// trick off and starts nothing. Inside the lock the four places are only RENAMED aside, to `.gone-<id>-<random>`
// beside each (approved.ts `moveAside`); the deletes run after the unlock, so a slow delete never holds the lock
// that every other writer waits at most six seconds for. A crash between the rename and the delete leaves only
// dotted names, which no scan, add or list reads as a trick, and the bridge's next start sweeps them
// (approved.ts `sweepGone`).

/** What the app and the command say while a run of the trick is going, queued or waiting on a Hill answer. */
export const REMOVE_RUNNING_LINE = "A run of this trick is still going. Try again in a few seconds.";
/** What the app says for a trick that is on. The command prints its own line, which names `collie trick off`. */
export const REMOVE_ON_LINE = "Switch the trick off to remove it.";
/** What is said when a place is a link or a file, or its real path lies outside the tricks folders. */
export const REMOVE_LINK_LINE = "A folder of this trick is a link or lies outside the tricks folder, so nothing was removed. Look at it on the machine.";

/** Why a remove was refused. `unknown-trick`: no folder of that id; nothing else is told. */
export type RemoveRefusal = "unknown-trick" | "on" | "running" | "link";

export type RemoveResult = { ok: true; folder: string; state: string } | { ok: false; code: RemoveRefusal; message: string };

export interface RemoveOptions {
  configDir: string;
  stateDir: string;
  id: string;
  /** Whether a run of the trick is going, queued or waiting on a Hill answer. Asked inside the switch file's lock. */
  busy: (id: string) => boolean;
  /** Drop what lives beside the files (agent views, Hill keys). Runs after the unlock, before the deletes. */
  forget?: (id: string) => void | Promise<void>;
}

/** One of the four places, and the real path it must have. */
interface Place {
  path: string;
  /** The real folder `path` must lie in; its real path joined with the id is what `path` must resolve to. */
  base: string;
}

/** The trick's own folder, and the three places beside it: its state folder, its approved and its pending copies. */
interface Places {
  folder: Place;
  rest: Place[];
}

function placesOf(configDir: string, stateDir: string, id: string): Places {
  const root = tricksConfigDir(configDir);
  return {
    folder: { path: join(root, id), base: root },
    rest: [
      { path: join(tricksStateDir(stateDir), id), base: tricksStateDir(stateDir) },
      { path: join(root, APPROVED_DIR, id), base: join(root, APPROVED_DIR) },
      { path: join(root, PENDING_DIR, id), base: join(root, PENDING_DIR) },
    ],
  };
}

/** `absent`, `ok`, or `bad` (a link or a file in its place, or a real path outside its base). Never throws. */
async function placeState(place: Place, id: string, realRoot: string, rootOf: (base: string) => string): Promise<"absent" | "ok" | "bad"> {
  const st = await lstat(place.path).catch(() => null);
  if (st === null) return "absent";
  if (!st.isDirectory()) return "bad";
  const real = await realpath(place.path).catch(() => null);
  return real === join(rootOf(realRoot), id) ? "ok" : "bad";
}

/** Every place checked: whether the trick folder is there, and whether any place is a link or outside its base. */
async function checkPlaces(configDir: string, stateDir: string, id: string): Promise<"absent" | "ok" | "bad"> {
  const { folder, rest } = placesOf(configDir, stateDir, id);
  const realConfig = await realpath(tricksConfigDir(configDir)).catch(() => null);
  if (realConfig === null) return "absent";
  const first = await placeState(folder, id, realConfig, (r) => r);
  if (first !== "ok") return first;
  // The state folder's base is resolved on its own: the state folder may live on another disk than the config.
  const realState = await realpath(tricksStateDir(stateDir)).catch(() => null);
  const states = await Promise.all([
    realState === null ? Promise.resolve<"absent">("absent") : placeState(rest[0]!, id, realState, (r) => r),
    placeState(rest[1]!, id, realConfig, (r) => join(r, APPROVED_DIR)),
    placeState(rest[2]!, id, realConfig, (r) => join(r, PENDING_DIR)),
  ]);
  return states.includes("bad") ? "bad" : "ok";
}

/**
 * Remove one trick: refused for an id that is no trick id or has no folder, for a trick that is on or has a run going,
 * and for a place that is a link or lies outside the tricks folders. Each refusal deletes nothing. Throws only when a
 * rename fails for another reason than a missing path; the places already moved are put back first.
 */
export async function removeTrick(opts: RemoveOptions): Promise<RemoveResult> {
  const { configDir, stateDir, id } = opts;
  if (!isTrickId(id)) return { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
  const before = await checkPlaces(configDir, stateDir, id);
  if (before === "absent") return { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
  if (before === "bad") return { ok: false, code: "link", message: REMOVE_LINK_LINE };
  const { folder, rest } = placesOf(configDir, stateDir, id);
  let refusal: RemoveResult | null = null;
  const aside: { from: string; to: string }[] = [];
  await updateSwitches(stateDir, async (now) => {
    // Asked again under the lock: a folder that went or became a link, a switch on, a run that began.
    const held = await checkPlaces(configDir, stateDir, id);
    if (held === "absent") refusal = { ok: false, code: "unknown-trick", message: `There is no trick ${id}.` };
    else if (held === "bad") refusal = { ok: false, code: "link", message: REMOVE_LINK_LINE };
    else if (now.on.has(id)) refusal = { ok: false, code: "on", message: REMOVE_ON_LINE };
    else if (opts.busy(id)) refusal = { ok: false, code: "running", message: REMOVE_RUNNING_LINE };
    if (refusal !== null) return now;
    try {
      for (const place of [folder, ...rest]) {
        const to = await moveAside(place.path, id);
        if (to !== null) aside.push({ from: place.path, to });
      }
    } catch (err) {
      // Put back what moved, newest first, so a failed remove leaves the trick as it was.
      for (const moved of aside.toReversed()) await rename(moved.to, moved.from).catch(() => {});
      aside.length = 0;
      throw err;
    }
    return now;
  });
  if (refusal !== null) return refusal;
  try {
    await opts.forget?.(id);
  } finally {
    // Outside the lock, and also when `forget` threw: what went aside is not wanted back.
    for (const moved of aside) await removeTree(moved.to);
  }
  return { ok: true, folder: folder.path, state: rest[0]!.path };
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
