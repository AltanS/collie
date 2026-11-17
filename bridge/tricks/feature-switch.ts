import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonBoolean, asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import { tricksStateDir } from "./paths.ts";

// THE SWITCH FOR TRICKS AS A WHOLE (package H, 2026-11-17). Tricks are an experiment and OFF by default:
// this one setting turns them on for this machine, on every phone at once. It is the Hill's switch
// (bridge/hill/switch.ts) in shape and rules. One file, `<stateDir>/tricks/feature.json`, mode 0600:
//
//   { "v": 1, "on": false, "at": "2026-11-17T09:41:00.000Z" }
//
// No file is OFF. A file that does not read is OFF too, with one warning per change of the file: an
// experiment that runs code and cannot be read stays shut. A trick id never holds a dot (`isTrickId`), so
// the name never meets a trick's own state folder beside it.
//
// WHAT OFF MEANS (service.ts `switchedOff`, the one check point): no trick's program runs (start, timer, a
// tap, a Decision's answer), no part is drawn anywhere, no agent view opens or hands out its rules, no
// trick Decision is posted, and nothing is switched on, approved, added or placed by a proposal. The
// list stays readable. Each trick keeps its own switch (`switches.json`): this file never changes it, so
// tricks that were on run again once this is on, and nothing new is switched on by it.
//
// TWO WRITERS, ONE VALUE. The phone writes through the bridge (`POST /api/tricks/switch`) and the
// operator's terminal writes the file itself (`collie tricks on|off`). Each write sets the whole value,
// never a change to a value read first, so a temp file renamed over the old one is enough: the last writer
// wins and nothing is half written. The bridge rereads the file behind a stat check, so a switch takes
// effect within a second, with no restart.
//
// THREE READINGS, as the Hill's. `on` and `off` are what a written file says; `unset` is no file. Every
// door reads unset as off. One place reads it apart: a crew MEMBER answers its lead's read of a trick's
// inputs unless its own file says off (bridge/index.ts), as a member with no Hill file follows its lead.

/** The file's name inside `<stateDir>/tricks/`. */
export const TRICKS_FEATURE_FILE = "feature.json";

/** Where the switch lives for one instance's state dir. */
export function tricksFeaturePath(stateDir: string): string {
  return join(tricksStateDir(stateDir), TRICKS_FEATURE_FILE);
}

/** What the switch holds: written on, written off, or no file (unset, which reads as off). */
export type TricksFeatureReading = "on" | "off" | "unset";

/** The file read: whether tricks are on, and why the file read as off when it did. */
export interface ParsedTricksFeature {
  readonly on: boolean;
  readonly problem: string | null;
}

/** Parse the file's text. Total: no file is off, and anything that is not the shape reads as off. */
export function parseTricksFeature(text: string | null): ParsedTricksFeature {
  if (text === null) return { on: false, problem: null };
  const doc = asJsonObject(parseJson(text));
  const on = asJsonBoolean(doc?.on);
  if (doc?.v !== 1 || on === undefined) return { on: false, problem: `${TRICKS_FEATURE_FILE} is not a version 1 switch file; tricks read as off` };
  return { on, problem: null };
}

/** The file's text for one value. */
export function renderTricksFeature(on: boolean, at: string): string {
  return `${JSON.stringify({ v: 1, on, at }, null, 2)}\n`;
}

/** Read the switch once, with no cache: what `collie tricks` and the CLI's refusals check. */
export function readTricksFeature(stateDir: string): ParsedTricksFeature & { readonly reading: TricksFeatureReading } {
  let text: string | null;
  try {
    text = readFileSync(tricksFeaturePath(stateDir), "utf8");
  } catch {
    text = null;
  }
  const parsed = parseTricksFeature(text);
  return { ...parsed, reading: text === null ? "unset" : parsed.on ? "on" : "off" };
}

/**
 * THE ONE WRITE of the switch, for every writer: the tricks folder at 0700, the file at 0600 through a temp
 * sibling of its own, so a reader never sees half a file. Throws when the folder or the file cannot be
 * written. True when the value moved.
 */
export function writeTricksFeature(stateDir: string, on: boolean, now: number = Date.now()): boolean {
  const before = readTricksFeature(stateDir).on;
  const dir = tricksStateDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = tricksFeaturePath(stateDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, renderTricksFeature(on, new Date(now).toISOString()), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return before !== on;
}

/** What the runner and the Hill ask of the switch: whether tricks are on now. A test passes a plain object. */
export interface TricksFeaturePort {
  on(): boolean;
}

/** Called with the new value each time a read or a write sees the switch move. Must return at once. */
export type TricksFeatureListener = (on: boolean) => void;

/**
 * The bridge's switch: read behind a stat check (the last reading is kept until the file moves), and
 * written by the phone's route. Synchronous, because the snapshot, a run's check and the local API ask it
 * on their own path. {@link onChange} tells a listener of every move a read or a write sees; the tricks
 * runner reads it every second (service.ts `tick`), so a terminal's write reaches listeners within a second.
 */
export class TricksFeatureSwitch implements TricksFeaturePort {
  private seen: string | undefined;
  private current: TricksFeatureReading = "unset";
  private readonly listeners = new Set<TricksFeatureListener>();

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(`[tricks] ${line}`),
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether tricks are on now. Unset is off. */
  on(): boolean {
    return this.reading() === "on";
  }

  /** What the switch holds now: on, off, or unset (no file). */
  reading(): TricksFeatureReading {
    const path = tricksFeaturePath(this.stateDir);
    let stamp: string;
    try {
      const st = statSync(path);
      // The inode moves on every rename, so two writes in the same millisecond are still told apart.
      stamp = `${String(st.mtimeMs)}:${String(st.ino)}:${String(st.size)}`;
    } catch {
      stamp = "none";
    }
    if (stamp === this.seen) return this.current;
    const wasOn = this.current === "on";
    this.seen = stamp;
    if (stamp === "none") {
      this.current = "unset";
    } else {
      const read = readTricksFeature(this.stateDir);
      if (read.problem !== null) this.warn(read.problem);
      this.current = read.on ? "on" : "off";
    }
    const isOn = this.current === "on";
    if (isOn !== wasOn) this.tell(isOn);
    return this.current;
  }

  /** Set the switch. True when the file was written; the reading follows the file either way. */
  set(on: boolean): boolean {
    try {
      writeTricksFeature(this.stateDir, on, this.now());
    } catch (err) {
      this.warn(`could not write ${tricksFeaturePath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.on() === on;
  }

  /** Listen for every move of the switch; the answer stops listening. A listener that throws is one warning. */
  onChange(listener: TricksFeatureListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private tell(on: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(on);
      } catch (err) {
        this.warn(`a listener of the tricks switch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
