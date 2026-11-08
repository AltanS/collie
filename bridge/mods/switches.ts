import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { modsStateDir, switchesPath } from "./paths.ts";

// THE ON AND OFF SWITCH (M94 slice 01). Bridge state, not a phone preference, so two phones agree and
// an "off" mod does not run. One file, `<stateDir>/mods/switches.json`, mode 0600:
//
//   { "v": 1, "on": { "legs": "2026-11-08T09:41:00.000Z" } }
//
// A mod is ON exactly when its id is a key of `on`; the value is when it was switched on. A new folder
// is OFF, so adding a mod runs nothing. The bridge rereads the file behind an mtime check, so
// `collie mod on` takes effect on the next tick with no restart. A file that does not parse reads as
// "everything off" with one warning per change: the safe direction for a switch that runs code.

export interface Switches {
  /** Mod id to the instant it was switched on. */
  on: ReadonlyMap<string, string>;
}

const EMPTY: Switches = { on: new Map() };

/** The switch file read: the switches, and why it read as all off when it did. */
export interface ParsedSwitches {
  switches: Switches;
  problem: string | null;
}

/** Parse the switch file's text. Total: anything that is not the shape reads as all off. */
export function parseSwitches(text: string | null): ParsedSwitches {
  if (text === null) return { switches: EMPTY, problem: null };
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.v) !== 1) {
    return { switches: EMPTY, problem: "switches.json is not a version 1 switch file; every mod reads as off" };
  }
  const on = asJsonObject(doc.on);
  if (on === undefined) return { switches: EMPTY, problem: 'switches.json has no "on" table; every mod reads as off' };
  const map = new Map<string, string>();
  for (const [id, value] of Object.entries(on)) {
    const at = asJsonString(value);
    if (at !== undefined) map.set(id, at);
  }
  return { switches: { on: map }, problem: null };
}

/** The file's text for a set of switches. Keys sorted, so a rewrite of the same set is the same bytes. */
export function renderSwitches(switches: Switches): string {
  const on: Record<string, string> = {};
  for (const id of [...switches.on.keys()].toSorted()) on[id] = switches.on.get(id) ?? "";
  return `${JSON.stringify({ v: 1, on }, null, 2)}\n`;
}

/** The same set with `id` switched on (at `at`) or off. */
export function withSwitch(switches: Switches, id: string, on: boolean, at: string): Switches {
  const next = new Map(switches.on);
  if (on) next.set(id, switches.on.get(id) ?? at);
  else next.delete(id);
  return { on: next };
}

/**
 * Write the switch file under `stateDir`: the folder at 0700, the file at 0600 through its `.tmp`
 * sibling, so a reader never sees half a file.
 */
export async function writeSwitches(stateDir: string, switches: Switches): Promise<void> {
  const path = switchesPath(stateDir);
  await mkdir(modsStateDir(stateDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  // The temp file is born in <stateDir>/mods, beside its target, so it inherits the folder's list.
  await writeFile(tmp, renderSwitches(switches), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(dirname(path), 0o700).catch(() => {});
}

/** The bridge's reader: the switches behind an mtime check, last read kept until the file moves. */
export function createSwitchReader(stateDir: string, warn: (line: string) => void): () => Promise<Switches> {
  const path = switchesPath(stateDir);
  let seen: number | null | undefined;
  let current = EMPTY;
  return async () => {
    let mtime: number | null;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      mtime = null;
    }
    if (mtime === seen) return current;
    seen = mtime;
    if (mtime === null) {
      current = EMPTY;
      return current;
    }
    let text: string | null;
    try {
      text = await Bun.file(path).text();
    } catch {
      text = null;
    }
    const { switches, problem } = parseSwitches(text);
    if (problem !== null) warn(problem);
    current = switches;
    return current;
  };
}
