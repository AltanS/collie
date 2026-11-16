import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonBoolean, asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import { hillDir } from "./store.ts";

// THE HILL'S SWITCH (2026-11-10). The Hill is an experiment and OFF by default (2026-11-13); this one
// bridge setting turns it on for this instance. Bridge state, not a phone preference, so two phones agree and an
// agent's post is refused on the machine itself. One file, `<stateDir>/hill/switch.json`, mode 0600:
//
//   { "v": 1, "on": false, "at": "2026-11-10T09:41:00.000Z" }
//
// No file is OFF, and a crew member with no file follows its lead (three readings, below). Off means: `hill.post` is refused (`hill_off`), a trick's Decisions are not posted,
// no Decision pushes, the phone's bar loses the Hill item and `/hill` says the Hill is off. The open
// Decisions stay in the store untouched; they show again when the Hill is back on, and their expiry
// still runs. `collie hill status`, `list` and `withdraw` keep working, so an agent can clean up.
// The switch gates what agents and tricks ASK. A card of Collie's own about a trick (a proposal, a new
// version, a trick's rights, a carried trick) is an approval: it is posted, read and answered with the
// Hill on or off, and with the Hill off the phone reads only those cards (M96 spec 14, service.ts).
//
// TWO WRITERS, ONE VALUE. The phone writes through the bridge (`POST /api/hill/switch`) and the
// operator's terminal writes the file itself (`collie hill on|off`), as `collie trick on|off` writes
// the tricks' switch file. Each write sets the whole value, never a change to a value read first, so a
// temp file renamed over the old one is enough: the last writer wins and nothing is half written. The
// bridge rereads the file behind a stat check, so a switch takes effect with no restart.
//
// THREE READINGS. `on` and `off` are what a written file says. `unset` is no file at all. A bridge reads
// unset as off, except a crew MEMBER: with no file of its own it does not refuse a post or an image, it
// forwards, and the lead's switch decides (service.ts `refusesHere`). A member whose file says off
// still refuses on its own machine.
//
// A FILE THAT DOES NOT READ reads as OFF, with one warning per change of the file. An experiment that
// cannot be read stays shut. It is an explicit off, so a member does not follow its lead past it.
//
// THE SKILL FOLLOWS THE SWITCH (M96 spec 12, ADR 0111's addendum of 2026-11-16). The installed WalkyTalky
// skill holds the Hill's words only while the Hill is on, so every writer goes through {@link
// setHillSwitch}: the phone's route (through {@link HillSwitch.set}), `collie hill on|off`, and the
// takeover's adopt (crew/hill-adopt.ts). It writes the file and, only when the value read before differs
// from the value written, calls the writer's follower once: the bridge spawns its own `skill sync`
// (hill/skill-follow.ts), the CLI runs the sync in its process (cli/skill-install.ts). The follower gets
// nothing from a request, and it is never awaited here. A follower that throws is one warning line; the
// switch is written and its answer stands. A bridge start writes no switch, so it syncs nothing. The
// skill reads "no file" as off, as a lead does; a crew member with no file has the off text.

/**
 * What runs after a real change of the switch: the skill sync of the writer's own kind. It must return
 * at once (a bridge's spawns the sync and does not wait); a throw is caught and logged by the caller.
 */
export type SwitchFollower = (on: boolean) => void;

/** The switch file's name inside the hill folder. */
export const HILL_SWITCH_FILE = "switch.json";

/** Where the switch lives for one instance's state dir. */
export function hillSwitchPath(stateDir: string): string {
  return join(hillDir(stateDir), HILL_SWITCH_FILE);
}

/** What the switch holds: written on, written off, or no file (unset, which reads as off on a lead). */
export type HillSwitchReading = "on" | "off" | "unset";

/** The switch file read: whether the Hill is on, and why the file read as the default when it did. */
export interface ParsedHillSwitch {
  readonly on: boolean;
  readonly problem: string | null;
}

/** Parse the switch file's text. Total: no file is off, and anything that is not the shape reads as off. */
export function parseHillSwitch(text: string | null): ParsedHillSwitch {
  if (text === null) return { on: false, problem: null };
  const doc = asJsonObject(parseJson(text));
  const on = asJsonBoolean(doc?.on);
  if (doc?.v !== 1 || on === undefined) return { on: false, problem: `${HILL_SWITCH_FILE} is not a version 1 switch file; the Hill reads as off` };
  return { on, problem: null };
}

/** The file's text for one value. */
export function renderHillSwitch(on: boolean, at: string): string {
  return `${JSON.stringify({ v: 1, on, at }, null, 2)}\n`;
}

/**
 * Write the switch: the hill folder at 0700, the file at 0600 through a temp sibling of its own, so a
 * reader never sees half a file. Throws when the folder or the file cannot be written. A writer calls
 * {@link setHillSwitch}, never this, so the skill follows; tests use it to lay a file down.
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

export interface SetHillSwitchOptions {
  readonly now?: number;
  /** The skill sync of this writer, or null where nothing follows (a test). */
  readonly follow: SwitchFollower | null;
  /** Where a follower's fault goes, as one line. */
  readonly warn: (line: string) => void;
}

/**
 * THE ONE WRITE OF THE SWITCH for every writer: write it ({@link writeHillSwitch}, which throws when it
 * cannot), then, when the value moved, let the skill follow. True when the value moved. The follower's
 * fault never reaches the caller: the switch is written either way.
 */
export function setHillSwitch(stateDir: string, on: boolean, opts: SetHillSwitchOptions): boolean {
  const before = readHillSwitch(stateDir).on;
  writeHillSwitch(stateDir, on, opts.now);
  if (before === on) return false;
  try {
    opts.follow?.(on);
  } catch (err) {
    opts.warn(`the WalkyTalky skill did not follow the switch: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
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
  private current: HillSwitchReading = "unset";

  constructor(
    private readonly stateDir: string,
    /** The bridge's skill sync after a real change (hill/skill-follow.ts); null where nothing follows. */
    private readonly follow: SwitchFollower | null,
    private readonly warn: (line: string) => void = (line) => console.warn(`[hill] ${line}`),
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the Hill is on now. Unset is off. */
  on(): boolean {
    return this.reading() === "on";
  }

  /** What the switch holds now: on, off, or unset (no file). */
  reading(): HillSwitchReading {
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
      this.current = "unset";
      return this.current;
    }
    const read = readHillSwitch(this.stateDir);
    if (read.problem !== null) this.warn(read.problem);
    this.current = read.on ? "on" : "off";
    return this.current;
  }

  /**
   * Set the switch. True when the file was written; the reading follows the file either way. A real
   * change starts the skill sync and does not wait for it ({@link setHillSwitch}).
   */
  set(on: boolean): boolean {
    try {
      setHillSwitch(this.stateDir, on, { now: this.now(), follow: this.follow, warn: this.warn });
    } catch (err) {
      this.warn(`could not write ${hillSwitchPath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.on() === on;
  }
}
