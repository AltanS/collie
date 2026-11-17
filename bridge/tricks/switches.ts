import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { tricksStateDir, switchesPath } from "./paths.ts";

// THE ON AND OFF SWITCH (M94 slice 01, version 3 since the approved copy). Bridge state, not a phone
// preference, so two phones agree and an "off" trick does not run. One file,
// `<stateDir>/tricks/switches.json`, mode 0600:
//
//   { "v": 2, "layout": 3, "on": { "legs": { "at": "2026-11-08T09:41:00.000Z", "hash": "<sha256 of the code>",
//       "auto": false, "by": "cli", "powers": "<16 hex>",
//       "previous": { "hash": "…", "at": "…", "by": "phone", "powers": "…" }, "declined": "<sha256>" } } }
//
// A trick is ON exactly when its id is a key of `on`. `hash` is the code hash (code-hash.ts) of the version
// a person approved, and `<configDir>/tricks/.collie-approved/<id>/<hash16>/` holds a copy of exactly those bytes
// (approved.ts): the trick runs from that copy, so an edit of its folder never stops it. `hash` is null
// when nothing is approved yet (a version 1 entry, or a version 2 entry whose folder changed before the
// copy existed): the trick is on but runs nothing until a person says yes to a version.
//
//   * `at` and `by`: when the version was approved, and who: `cli`, `phone`, `auto` (taken without asking),
//     `migrated` (a version 2 entry whose folder still hashed the same), or a later slice's word.
//   * `auto`: "take changes without asking". A code change whose powers did not move is approved on its own.
//   * `powers`: a short hash of the rights the manifest asks for (approved.ts `powersOf`), as approved.
//   * `previous`: the version before the last one, kept for undo.
//   * `declined`: a version the person said no to, so it is not offered again.
//   * `from`: the crew lead the version was carried from by a takeover or a handover (`by` then names it).
//
// LAYOUT 3, WRITTEN AS VERSION 2 (security re-review B4). The file says `"v": 2` and marks the approved-copy
// layout with `"layout": 3`, so the previous build (whose parser reads `v` 1 or 2, `at` and `hash` per entry
// and ignores any other field) still reads every switch after a rollback: each trick on, with the hash a
// person approved, which that build runs only while the folder still hashes so. A write by that build
// drops `layout` and the new fields (`auto`, `by`, `powers`, `previous`, `declined`) but keeps every switch
// and hash. This build reads such a file as plain version 2 and migrates it (approved.ts
// `migrateSwitches`), keeping an approved copy that is still on disk. Losing `auto` asks again, the safe
// way; losing `previous` loses undo; losing `declined` offers that version once more. A file of `"v": 3`
// (written by this branch before the change) is read as layout 3 too.
//
// A version 1 file (`"legs": "<instant>"`) and a plain version 2 file (`{at, hash}`) are migrated at boot.
//
// A new folder is OFF, so adding a trick runs nothing. The bridge rereads the file behind a stat check,
// so `collie trick on` takes effect on the next tick with no restart. A file that does not parse reads
// as "everything off" with one warning per change: the safe direction for a switch that runs code.
//
// ONE WRITER AT A TIME. The CLI and the bridge both write the file, each through {@link updateSwitches}:
// take the lock file (exclusive create, pid and nonce inside, taken over only when that pid is dead), read the file again,
// apply the one change, write a temp file and rename it over. Two writers never lose each other's change.

/** The layout this Collie writes (approved copies): `"layout": 3` in a file that says `"v": 2`. */
export const SWITCHES_VERSION = 3;

/** The `by` of an entry the boot migration wrote (approved.ts `migrateSwitches`): its null powers hold the old build's rights. */
export const MIGRATED = "migrated";
/** The `v` the file carries, so the previous build's parser still reads it. */
const FILE_V = 2;

/** A version kept for undo: its hash, when and by whom it was approved, and its powers. */
export interface PreviousVersion {
  hash: string;
  at: string;
  by: string;
  powers: string | null;
}

/** One switched-on trick. */
export interface SwitchEntry {
  /** When the approved version was approved. */
  at: string;
  /** The code hash of the approved version, or null when nothing is approved yet. */
  hash: string | null;
  /** Take a code change whose powers did not move without asking. */
  auto: boolean;
  /** Who approved: `cli`, `phone`, `auto`, `migrated`, or a later word. Display and audit only. */
  by: string;
  /** The powers hash of the approved version, or null when it is not known (an older entry). */
  powers: string | null;
  previous?: PreviousVersion;
  /** A code hash the person declined: not offered again while the folder still hashes to it. */
  declined?: string;
  /**
   * The crew lead this version was carried from, when a takeover or a handover started it here
   * (crew/carry-adopt.ts; `by` is then `takeover` or `handover`). Audit and display only.
   */
  from?: string;
}

export interface Switches {
  /** Trick id to its entry. */
  on: ReadonlyMap<string, SwitchEntry>;
  /** The layout of the file read: 0 for no file, 1 or 2 for an older file, 3 for the approved-copy layout. A write is always 3. */
  version?: number;
}

const EMPTY: Switches = { on: new Map(), version: 0 };

/** How long a writer waits for the lock before it gives up. */
export const SWITCH_LOCK_WAIT_MS = 6000;
/**
 * A lock or door file that is empty or holds no pid, older than this, is read as dead. This code never shows a half
 * written file (it links a whole one onto the path), but an older build created the file and wrote it after, and a
 * crash between the two left an empty lock that nothing else would ever clear.
 */
export const SWITCH_LOCK_BLANK_MS = 30_000;

/** The switch file read: the switches, and why it read as all off when it did. */
export interface ParsedSwitches {
  switches: Switches;
  problem: string | null;
}

const HASH = /^[0-9a-f]{64}$/;
const POWERS = /^[0-9a-f]{16}$/;

function hashOf(value: JsonValue | undefined): string | null {
  const text = asJsonString(value);
  return text !== undefined && HASH.test(text) ? text : null;
}

function powersOf(value: JsonValue | undefined): string | null {
  const text = asJsonString(value);
  return text !== undefined && POWERS.test(text) ? text : null;
}

function previousOf(value: JsonValue | undefined): PreviousVersion | undefined {
  const doc = asJsonObject(value);
  const hash = hashOf(doc?.hash);
  const at = asJsonString(doc?.at);
  if (doc === undefined || hash === null || at === undefined) return undefined;
  return { hash, at, by: asJsonString(doc.by) ?? "cli", powers: powersOf(doc.powers) };
}

/** One entry of the `on` table, of any version, or undefined when it is not one. */
function entryOf(value: JsonValue | undefined): SwitchEntry | undefined {
  const plain = asJsonString(value);
  if (plain !== undefined) return { at: plain, hash: null, auto: false, by: "cli", powers: null };
  const doc = asJsonObject(value);
  const at = asJsonString(doc?.at);
  if (doc === undefined || at === undefined) return undefined;
  const entry: SwitchEntry = { at, hash: hashOf(doc.hash), auto: asJsonBoolean(doc.auto) === true, by: asJsonString(doc.by) ?? "cli", powers: powersOf(doc.powers) };
  const previous = previousOf(doc.previous);
  if (previous !== undefined) entry.previous = previous;
  const declined = hashOf(doc.declined);
  if (declined !== null) entry.declined = declined;
  const from = asJsonString(doc.from);
  if (from !== undefined && from !== "" && from.length <= 64) entry.from = from;
  return entry;
}

/** Parse the switch file's text. Total: anything that is not the shape reads as all off. */
export function parseSwitches(text: string | null): ParsedSwitches {
  if (text === null) return { switches: EMPTY, problem: null };
  const doc = asJsonObject(parseJson(text));
  const v = asJsonNumber(doc?.v);
  if (doc === undefined || (v !== 1 && v !== 2 && v !== 3)) {
    return { switches: EMPTY, problem: "switches.json is not a version 1, 2 or 3 switch file; every trick reads as off" };
  }
  const layout = v === 3 || (v === 2 && asJsonNumber(doc.layout) === SWITCHES_VERSION) ? SWITCHES_VERSION : v;
  const on = asJsonObject(doc.on);
  if (on === undefined) return { switches: EMPTY, problem: 'switches.json has no "on" table; every trick reads as off' };
  const map = new Map<string, SwitchEntry>();
  for (const [id, value] of Object.entries(on)) {
    const entry = entryOf(value);
    if (entry !== undefined) map.set(id, entry);
  }
  return { switches: { on: map, version: layout }, problem: null };
}

/** One entry as the file holds it. Absent fields stay absent, so a rewrite of the same set is the same bytes. */
function renderEntry(entry: SwitchEntry): JsonObject {
  const out: JsonObject = { at: entry.at, hash: entry.hash, auto: entry.auto, by: entry.by, powers: entry.powers };
  if (entry.previous !== undefined) out.previous = { hash: entry.previous.hash, at: entry.previous.at, by: entry.previous.by, powers: entry.previous.powers };
  if (entry.declined !== undefined) out.declined = entry.declined;
  if (entry.from !== undefined) out.from = entry.from;
  return out;
}

/** The file's text for a set of switches: always layout 3, as `v` 2. Keys sorted, so a rewrite of the same set is the same bytes. */
export function renderSwitches(switches: Switches): string {
  const on: JsonObject = {};
  for (const id of [...switches.on.keys()].toSorted()) {
    const entry = switches.on.get(id);
    if (entry !== undefined) on[id] = renderEntry(entry);
  }
  return `${JSON.stringify({ v: FILE_V, layout: SWITCHES_VERSION, on }, null, 2)}\n`;
}

/** The same set with one entry put in (or replaced). */
export function withEntry(switches: Switches, id: string, entry: SwitchEntry): Switches {
  const next = new Map(switches.on);
  next.set(id, entry);
  return { on: next, version: SWITCHES_VERSION };
}

/** What an approval records. */
export interface Approval {
  at: string;
  hash: string;
  by: string;
  powers: string | null;
  /** The version approved gives agents instructions (`rules`, contract 2): `auto` is written false (review 8 V-N6). */
  instructs?: boolean;
}

/**
 * The same set with `id` approved at a version: on, with this hash. `auto` stays as it was; the version
 * approved before (when it differs) becomes `previous`, for undo; a decline is cleared.
 */
export function withApproval(switches: Switches, id: string, approval: Approval): Switches {
  const held = switches.on.get(id);
  // A trick with rules never takes changes without asking: an older `auto` is cleared, not hidden, so a later
  // version that drops the rules does not take itself on the strength of it.
  const auto = approval.instructs === true ? false : (held?.auto ?? false);
  const entry: SwitchEntry = { at: approval.at, hash: approval.hash, auto, by: approval.by, powers: approval.powers };
  if (held?.hash != null && held.hash !== approval.hash) entry.previous = { hash: held.hash, at: held.at, by: held.by, powers: held.powers };
  else if (held?.previous !== undefined) entry.previous = held.previous;
  return withEntry(switches, id, entry);
}

/**
 * The same set with `id` approved as a trick new to this machine: a fresh entry, whatever an entry of that
 * name held (the first full trick run, 2026-11-16, decision 3). No `auto`, no `previous` to undo to: an entry
 * left behind by a trick folder deleted by hand never lends a proposal its "take changes without asking" or
 * its Undo target.
 */
export function withFreshApproval(switches: Switches, id: string, approval: Approval): Switches {
  return withEntry(switches, id, { at: approval.at, hash: approval.hash, auto: false, by: approval.by, powers: approval.powers });
}

/**
 * The same set with `id` switched on (at `at`, approving the code `hash`) or off. The low-level setter a
 * test and an older caller use: `auto` and `previous` are kept, `by` is `cli`, the powers are `powers`, by
 * default not known. An entry with a hash and unknown powers does not run (fault B: service.ts
 * `rightsMovedOf`), so a test that switches a trick on passes the powers of its folder (approved.ts `powersOfDir`).
 */
export function withSwitch(switches: Switches, id: string, on: boolean, at: string, hash: string | null = null, powers: string | null = null): Switches {
  const next = new Map(switches.on);
  if (!on) {
    next.delete(id);
    return { on: next, version: SWITCHES_VERSION };
  }
  const held = switches.on.get(id);
  const entry: SwitchEntry = { at, hash, auto: held?.auto ?? false, by: "cli", powers };
  if (held?.previous !== undefined) entry.previous = held.previous;
  next.set(id, entry);
  return { on: next, version: SWITCHES_VERSION };
}

/**
 * Write the switch file under `stateDir`: the folder at 0700, the file at 0600 through a temp sibling
 * of its own, so a reader never sees half a file. Takes no lock: {@link updateSwitches} is the writer
 * for a change; this is for a whole set (a test's setup).
 */
export async function writeSwitches(stateDir: string, switches: Switches): Promise<void> {
  const path = switchesPath(stateDir);
  await mkdir(tricksStateDir(stateDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  // The temp file is born in <stateDir>/tricks, beside its target, so it inherits the folder's list.
  await writeFile(tmp, renderSwitches(switches), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(dirname(path), 0o700).catch(() => {});
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** The text of a lock or door file this process makes: its pid, which a waiter checks for life, then a nonce only it knows. */
function lockText(nonce: string): string {
  return `${String(process.pid)}\n${nonce}\n`;
}

/** What stands at a lock or door path: nothing, a file whose holder is alive (or that cannot be read as one), or a dead holder's file. */
type Holder = { kind: "none" } | { kind: "live" } | { kind: "dead"; text: string };

/**
 * Whether the process `pid` runs. A signal 0 sends nothing and checks only: ESRCH is the one answer that means
 * dead. EPERM (another user's process) and any other error count as alive, the safe side: a live holder is never
 * taken over, at worst a waiter gives up after {@link SWITCH_LOCK_WAIT_MS}.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err instanceof Error && "code" in err && err.code === "ESRCH");
  }
}

/**
 * Read a lock or door file. A pid that runs is alive, one that does not is dead. A file that is empty or holds no
 * pid is somebody else's being written: alive while it is younger than {@link SWITCH_LOCK_BLANK_MS}, dead after.
 */
async function readHolder(path: string, now: () => number): Promise<Holder> {
  const text = await readText(path);
  if (text === null) return { kind: "none" };
  const pid = /^([1-9]\d{0,9})\n/u.exec(text)?.[1];
  if (pid !== undefined) return pidAlive(Number(pid)) ? { kind: "live" } : { kind: "dead", text };
  const held = await stat(path).catch(() => null);
  if (held === null) return { kind: "none" };
  return now() - held.mtimeMs > SWITCH_LOCK_BLANK_MS ? { kind: "dead", text } : { kind: "live" };
}

/**
 * The file calls the lock makes that Windows can refuse for a moment (a test swaps them). Windows refuses a rename
 * over, a link onto or an unlink of a file another handle has open, for example a waiter reading the lock, with
 * EPERM, EACCES or EBUSY: {@link busyError}.
 */
export interface LockFs {
  link(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const DISK_LOCK_FS: LockFs = { link, rename, unlink };

/** How long a lock step waits after Windows said "not now". */
const BUSY_STEP_MS = 20;

/** An error that means "another handle has the file open, try again", not "this cannot work". */
function busyError<T>(err: T): boolean {
  return err instanceof Error && "code" in err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY");
}

/** Remove a path, trying again while Windows says "not now", within {@link SWITCH_LOCK_WAIT_MS}. Never throws. */
async function discard(fs: LockFs, path: string): Promise<void> {
  for (let tries = 0; tries < SWITCH_LOCK_WAIT_MS / BUSY_STEP_MS; tries += 1) {
    try {
      await fs.unlink(path);
      return;
    } catch (err) {
      if (!busyError(err)) return;
    }
    await Bun.sleep(BUSY_STEP_MS);
  }
}

/** A file of this process's lock text under a unique name in the same folder, ready to be linked or renamed onto a lock path. */
async function prepared(path: string, nonce: string): Promise<string> {
  const tmp = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  // Beside its target, in the same folder, so it inherits the folder's list.
  await writeFile(tmp, lockText(nonce), { mode: 0o600, flag: "wx" });
  return tmp;
}

/**
 * Create `path` holding this process's lock text, only when nothing stands there. The text is written first
 * under a name of its own and then linked onto the path: a link never replaces a file, and a waiter never sees
 * the lock half written. Answers `made`, `exists`, or `busy` when Windows refused the link for a moment.
 */
async function createExclusive(fs: LockFs, path: string, nonce: string): Promise<"made" | "exists" | "busy"> {
  const staged = await prepared(path, nonce);
  try {
    await fs.link(staged, path);
    return "made";
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return "exists";
    if (busyError(err)) return "busy";
    throw err;
  } finally {
    await discard(fs, staged);
  }
}

/** Remove `path` only while it still carries `nonce`: a file that is not this holder's is left alone. */
async function removeIfOwn(fs: LockFs, path: string, nonce: string): Promise<void> {
  const text = await readText(path);
  if (text === null || !text.split("\n").includes(nonce)) return;
  await discard(fs, path);
}

/**
 * Take the lock file. Answers the holder's nonce: the lock file carries it, and {@link releaseLock} removes the
 * lock only while it still does. Throws after {@link SWITCH_LOCK_WAIT_MS}, never before: a step Windows refused
 * for a moment is tried again within the same wait.
 *
 * A LIVE HOLDER IS NEVER TAKEN OVER (counsel A1, third pass). The work inside the lock is renames and one small
 * write, so a holder is quick or dead; there is no age rule for a lock with a pid. A lock whose pid is alive, or an
 * empty or pid-less one younger than {@link SWITCH_LOCK_BLANK_MS}, is waited for. A dead one goes through one door,
 * {@link replaceDead}.
 */
async function takeLock(lock: string, now: () => number, fs: LockFs): Promise<string> {
  const until = now() + SWITCH_LOCK_WAIT_MS;
  const nonce = randomBytes(16).toString("hex");
  // Bounded by the wait: every pass that does not take the lock sleeps at least 1 ms, so the passes outlast it.
  for (let pass = 0; pass < SWITCH_LOCK_WAIT_MS; pass += 1) {
    const made = await createExclusive(fs, lock, nonce);
    if (made === "made") return nonce;
    let gone = false;
    if (made === "exists") {
      const held = await readHolder(lock, now);
      gone = held.kind === "none";
      if (held.kind === "dead" && (await replaceDead({ path: lock, seen: held.text, nonce, depth: 0, now, fs }))) return nonce;
    }
    if (now() >= until) break;
    // Right after the lock went, try again at once; otherwise a short step.
    await Bun.sleep(gone ? 1 : BUSY_STEP_MS);
  }
  throw new Error(`switches.json is locked by another writer (${lock})`);
}

/**
 * The one door to a dead holder's file: `<path>.takeover`, created exclusive. Only its holder may replace `path`.
 * It reads `path` again, and only while it is the same file (`seen`, the nonce with it) and still dead (its pid
 * gone, or empty and still older than {@link SWITCH_LOCK_BLANK_MS}), renames its own prepared file OVER it: an
 * atomic replace, so the lock path is never missing and no other waiter can create a lock in between. At depth 0
 * the replacement is this waiter's lock (answers true); at depth 1 `path` is a dead waiter's door and is only removed.
 * A rename Windows refuses for a moment answers false: the door is released and the caller tries again.
 *
 * A door whose own pid is dead is cleared the same way, through the door's door (depth 1). A dead depth 1 door is
 * removed after it read dead: two waiters can race only there, after two holders died at the wrong moment.
 */
async function replaceDead(opts: { path: string; seen: string; nonce: string; depth: number; now: () => number; fs: LockFs }): Promise<boolean> {
  const door = `${opts.path}.takeover`;
  if ((await createExclusive(opts.fs, door, opts.nonce)) !== "made") {
    const blocking = await readHolder(door, opts.now);
    if (blocking.kind !== "dead") return false;
    if (opts.depth > 0) await opts.fs.unlink(door).catch(() => {});
    else await replaceDead({ ...opts, path: door, seen: blocking.text, depth: 1 });
    return false;
  }
  try {
    const again = await readHolder(opts.path, opts.now);
    if (again.kind !== "dead" || again.text !== opts.seen) return false;
    if (opts.depth > 0) {
      await opts.fs.unlink(opts.path).catch(() => {});
      return false;
    }
    const mine = await prepared(opts.path, opts.nonce);
    try {
      await opts.fs.rename(mine, opts.path);
    } catch (err) {
      await discard(opts.fs, mine);
      if (busyError(err)) return false;
      throw err;
    }
    return true;
  } finally {
    await removeIfOwn(opts.fs, door, opts.nonce);
  }
}

/** Remove the lock file only while it still carries this holder's nonce: a lock replaced after this holder died is another writer's. */
async function releaseLock(fs: LockFs, lock: string, nonce: string): Promise<void> {
  await removeIfOwn(fs, lock, nonce);
}

/**
 * Change the switch file by one change, safely against the other writer: lock, read again, apply,
 * write, unlock. Answers the switches as written. `change` may be async: the lock is held until it is done,
 * so a look at the disk it makes (is the folder still not there?) holds for the whole write.
 */
export async function updateSwitches(stateDir: string, change: (switches: Switches) => Switches | Promise<Switches>, now: () => number = Date.now): Promise<Switches> {
  return await withSwitchLock(
    stateDir,
    async () => {
      const next = await change(parseSwitches(await readText(switchesPath(stateDir))).switches);
      await writeSwitches(stateDir, next);
      return next;
    },
    now,
  );
}

/**
 * Hold the switch file's lock while `work` runs, and release it after, also when `work` throws. For a writer
 * that changes the trick folders and not the file (`collie trick update` swaps a folder), so a bridge's
 * approval or an add of the same id, which hold this lock, never see the folder half moved. A live holder is
 * never taken over, and a waiter gives up after {@link SWITCH_LOCK_WAIT_MS}: keep `work` short. `fs` is for a
 * test that plays Windows refusing a step.
 */
export async function withSwitchLock<T>(stateDir: string, work: () => Promise<T>, now: () => number = Date.now, fs: LockFs = DISK_LOCK_FS): Promise<T> {
  await mkdir(tricksStateDir(stateDir), { recursive: true, mode: 0o700 });
  const lock = `${switchesPath(stateDir)}.lock`;
  const nonce = await takeLock(lock, now, fs);
  try {
    return await work();
  } finally {
    await releaseLock(fs, lock, nonce);
  }
}

/** The bridge's reader: the switches behind a stat check, last read kept until the file moves. */
export function createSwitchReader(stateDir: string, warn: (line: string) => void): () => Promise<Switches> {
  const path = switchesPath(stateDir);
  let seen: string | undefined;
  let current = EMPTY;
  return async () => {
    let stamp: string;
    try {
      const st = await stat(path);
      // The inode moves on every rename, so two writes in the same millisecond are still told apart.
      stamp = `${String(st.mtimeMs)}:${String(st.ino)}:${String(st.size)}`;
    } catch {
      stamp = "none";
    }
    if (stamp === seen) return current;
    seen = stamp;
    if (stamp === "none") {
      current = EMPTY;
      return current;
    }
    const { switches, problem } = parseSwitches(await readText(path));
    if (problem !== null) warn(problem);
    current = switches;
    return current;
  };
}
