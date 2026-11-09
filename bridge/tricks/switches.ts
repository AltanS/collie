import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { tricksStateDir, switchesPath } from "./paths.ts";

// THE ON AND OFF SWITCH (M94 slice 01). Bridge state, not a phone preference, so two phones agree and
// an "off" trick does not run. One file, `<stateDir>/tricks/switches.json`, mode 0600:
//
//   { "v": 2, "on": { "legs": { "at": "2026-11-08T09:41:00.000Z", "hash": "<sha256 of the code>" } } }
//
// A trick is ON exactly when its id is a key of `on`. `at` is when it was switched on, and `hash` is
// the code hash (code-hash.ts) of the folder as it was then: the consent is to that code. A trick whose
// code no longer hashes the same is "changed" and does not run until it is switched on again. A version
// 1 file (`"legs": "<instant>"`) reads as on with no hash, so each of its tricks is "changed" once.
//
// A new folder is OFF, so adding a trick runs nothing. The bridge rereads the file behind a stat check,
// so `collie trick on` takes effect on the next tick with no restart. A file that does not parse reads
// as "everything off" with one warning per change: the safe direction for a switch that runs code.
//
// ONE WRITER AT A TIME. The CLI and the bridge both write the file, each through {@link updateSwitches}:
// take the lock file (exclusive create, stale after {@link SWITCH_LOCK_STALE_MS}), read the file again,
// apply the one change, write a temp file and rename it over. Two writers never lose each other's change.

/** One switched-on trick: when, and the code hash approved then (null in a version 1 file). */
export interface SwitchEntry {
  at: string;
  hash: string | null;
}

export interface Switches {
  /** Trick id to its entry. */
  on: ReadonlyMap<string, SwitchEntry>;
}

const EMPTY: Switches = { on: new Map() };

/** A lock file older than this is a writer that died: it is taken over. */
export const SWITCH_LOCK_STALE_MS = 5000;
/** How long a writer waits for the lock before it gives up. */
export const SWITCH_LOCK_WAIT_MS = 6000;

/** The switch file read: the switches, and why it read as all off when it did. */
export interface ParsedSwitches {
  switches: Switches;
  problem: string | null;
}

/** Parse the switch file's text. Total: anything that is not the shape reads as all off. */
export function parseSwitches(text: string | null): ParsedSwitches {
  if (text === null) return { switches: EMPTY, problem: null };
  const doc = asJsonObject(parseJson(text));
  const v = asJsonNumber(doc?.v);
  if (doc === undefined || (v !== 1 && v !== 2)) {
    return { switches: EMPTY, problem: "switches.json is not a version 1 or 2 switch file; every trick reads as off" };
  }
  const on = asJsonObject(doc.on);
  if (on === undefined) return { switches: EMPTY, problem: 'switches.json has no "on" table; every trick reads as off' };
  const map = new Map<string, SwitchEntry>();
  for (const [id, value] of Object.entries(on)) {
    const plain = asJsonString(value);
    if (plain !== undefined) {
      map.set(id, { at: plain, hash: null });
      continue;
    }
    const entry = asJsonObject(value);
    const at = asJsonString(entry?.at);
    const hash = asJsonString(entry?.hash);
    if (at !== undefined) map.set(id, { at, hash: hash !== undefined && /^[0-9a-f]{64}$/.test(hash) ? hash : null });
  }
  return { switches: { on: map }, problem: null };
}

/** The file's text for a set of switches. Keys sorted, so a rewrite of the same set is the same bytes. */
export function renderSwitches(switches: Switches): string {
  const on: Record<string, { at: string; hash: string | null }> = {};
  for (const id of [...switches.on.keys()].toSorted()) {
    const entry = switches.on.get(id);
    if (entry !== undefined) on[id] = { at: entry.at, hash: entry.hash };
  }
  return `${JSON.stringify({ v: 2, on }, null, 2)}\n`;
}

/** The same set with `id` switched on (at `at`, approving the code `hash`) or off. */
export function withSwitch(switches: Switches, id: string, on: boolean, at: string, hash: string | null = null): Switches {
  const next = new Map(switches.on);
  if (on) next.set(id, { at, hash });
  else next.delete(id);
  return { on: next };
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

/** Take the lock file, taking over a stale one. Throws after {@link SWITCH_LOCK_WAIT_MS}. */
async function takeLock(lock: string, now: () => number): Promise<void> {
  const until = now() + SWITCH_LOCK_WAIT_MS;
  // Bounded by the wait: each pass either takes the lock, removes a stale one, or sleeps 20 ms.
  for (let pass = 0; pass < SWITCH_LOCK_WAIT_MS; pass += 1) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${String(process.pid)}\n`);
      await handle.close();
      return;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    const held = await stat(lock).catch(() => null);
    if (held !== null && now() - held.mtimeMs > SWITCH_LOCK_STALE_MS) {
      await unlink(lock).catch(() => {});
      continue;
    }
    if (now() >= until) break;
    await Bun.sleep(20);
  }
  throw new Error(`switches.json is locked by another writer (${lock})`);
}

/**
 * Change the switch file by one change, safely against the other writer: lock, read again, apply,
 * write, unlock. Answers the switches as written.
 */
export async function updateSwitches(stateDir: string, change: (switches: Switches) => Switches, now: () => number = Date.now): Promise<Switches> {
  const path = switchesPath(stateDir);
  await mkdir(tricksStateDir(stateDir), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  await takeLock(lock, now);
  try {
    const next = change(parseSwitches(await readText(path)).switches);
    await writeSwitches(stateDir, next);
    return next;
  } finally {
    await unlink(lock).catch(() => {});
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
