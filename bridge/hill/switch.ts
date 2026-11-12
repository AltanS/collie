import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonBoolean, asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import { hillDir } from "./store.ts";

// THE HILL'S SWITCH (2026-11-10). The Hill is part of Collie and ON by default; this one bridge setting
// turns it off for this instance. Bridge state, not a phone preference, so two phones agree and an
// agent's post is refused on the machine itself. One file, `<stateDir>/hill/switch.json`, mode 0600:
//
//   { "v": 1, "on": false, "at": "2026-11-10T09:41:00.000Z" }
//
// No file is ON. Off means: `hill.post` is refused (`hill_off`), a trick's Decisions are not posted,
// no Decision pushes, the phone's bar loses the Hill item and `/hill` says the Hill is off. The open
// Decisions stay in the store untouched; they show again when the Hill is back on, and their expiry
// still runs. `collie hill status`, `list` and `withdraw` keep working, so an agent can clean up.
//
// TWO WRITERS, ONE VALUE. The phone writes through the bridge (`POST /api/hill/switch`) and the
// operator's terminal writes the file itself (`collie hill on|off`), as `collie trick on|off` writes
// the tricks' switch file. Each write sets the whole value, never a change to a value read first, so a
// temp file renamed over the old one is enough: the last writer wins and nothing is half written. The
// bridge rereads the file behind a stat check, so a switch takes effect with no restart.
//
// A FILE THAT DOES NOT READ reads as ON, the default, with one warning per change of the file. The
// switch hides a place; it runs nothing, so the default is the safe reading.

/** The switch file's name inside the hill folder. */
export const HILL_SWITCH_FILE = "switch.json";

/** Where the switch lives for one instance's state dir. */
export function hillSwitchPath(stateDir: string): string {
  return join(hillDir(stateDir), HILL_SWITCH_FILE);
}

/** The switch file read: whether the Hill is on, and why the file read as the default when it did. */
export interface ParsedHillSwitch {
  readonly on: boolean;
  readonly problem: string | null;
}

/** Parse the switch file's text. Total: no file is on, and anything that is not the shape reads as on. */
export function parseHillSwitch(text: string | null): ParsedHillSwitch {
  if (text === null) return { on: true, problem: null };
  const doc = asJsonObject(parseJson(text));
  const on = asJsonBoolean(doc?.on);
  if (doc?.v !== 1 || on === undefined) return { on: true, problem: `${HILL_SWITCH_FILE} is not a version 1 switch file; the Hill reads as on` };
  return { on, problem: null };
}

/** The file's text for one value. */
export function renderHillSwitch(on: boolean, at: string): string {
  return `${JSON.stringify({ v: 1, on, at }, null, 2)}\n`;
}

/**
 * Write the switch: the hill folder at 0700, the file at 0600 through a temp sibling of its own, so a
 * reader never sees half a file. Throws when the folder or the file cannot be written.
 */
export function writeHillSwitch(stateDir: string, on: boolean, now: number = Date.now()): void {
  const dir = hillDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = hillSwitchPath(stateDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, renderHillSwitch(on, new Date(now).toISOString()), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Read the switch once, with no cache: what `collie hill on|off` checks before it writes. */
export function readHillSwitch(stateDir: string): ParsedHillSwitch {
  let text: string | null;
  try {
    text = readFileSync(hillSwitchPath(stateDir), "utf8");
  } catch {
    text = null;
  }
  return parseHillSwitch(text);
}

/**
 * The bridge's switch: read behind a stat check (the last reading is kept until the file moves), and
 * written by the phone's route. Synchronous, because the snapshot and a post ask it on their own path.
 */
export class HillSwitch {
  private seen: string | undefined;
  private current = true;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(`[hill] ${line}`),
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the Hill is on now. */
  on(): boolean {
    const path = hillSwitchPath(this.stateDir);
    let stamp: string;
    try {
      const st = statSync(path);
      // The inode moves on every rename, so two writes in the same millisecond are still told apart.
      stamp = `${String(st.mtimeMs)}:${String(st.ino)}:${String(st.size)}`;
    } catch {
      stamp = "none";
    }
    if (stamp === this.seen) return this.current;
    this.seen = stamp;
    if (stamp === "none") {
      this.current = true;
      return this.current;
    }
    const read = readHillSwitch(this.stateDir);
    if (read.problem !== null) this.warn(read.problem);
    this.current = read.on;
    return this.current;
  }

  /** Set the switch. True when the file was written; the reading follows the file either way. */
  set(on: boolean): boolean {
    try {
      writeHillSwitch(this.stateDir, on, this.now());
    } catch (err) {
      this.warn(`could not write ${hillSwitchPath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.on() === on;
  }
}
