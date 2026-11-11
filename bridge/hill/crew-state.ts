import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { isHillCrewState, type HillCrewState, type HillCrewStateView } from "../../web/src/lib/hill/wire.ts";
import { headerField } from "../walky/types.ts";
import { hillDir } from "./store.ts";

// THE CREW STATE (1.29.0). The person tells the agents of the crew how fast an answer can come: `here`
// (as always), `quiet` or `away`. One value per lead, in `<stateDir>/hill/state.json`, mode 0600:
//
//   { "v": 1, "state": "away", "at": 1762873260000, "by": "Pixel 9" }
//
// and, once "Tell all sessions now" ran for this value, `"told": 4` (how many sessions it reached), so
// the button reads done on every phone and is never offered twice for one change.
//
// No file, or a file that does not read, is `here`, the default: the state changes no rule, so the
// default is the safe reading. What it changes, all on the lead: with `quiet` or `away` no Decision pushes
// (hill/service.ts `pushPlan`); a typed answer and a post result end with `Crew state: away.`. The bridge
// NEVER refuses a post because of it. Carried to the deputy with the Hill copy, as the Hill's switch is.
//
// TWO WRITERS, ONE VALUE, as switch.ts: the phone writes through the bridge (`POST /api/hill/state`), the
// operator's terminal through the walky socket (`collie hill state away`), or the file itself when no
// bridge runs. Each write sets the whole value through a temp file renamed over the old one; the bridge
// rereads the file behind a stat check, so a change takes effect with no restart.

/** The state file's name inside the hill folder. */
export const HILL_CREW_STATE_FILE = "state.json";

/** The longest `by` the file keeps. */
const BY_MAX = 80;

/** Where the crew state lives for one instance's state dir. */
export function hillCrewStatePath(stateDir: string): string {
  return join(hillDir(stateDir), HILL_CREW_STATE_FILE);
}

/** The default: `here`, never set. */
export const HILL_CREW_STATE_DEFAULT: HillCrewStateView = { state: "here", at: null, by: null, told: null };

/** The file read: the value, and why it read as the default when it did. */
export interface ParsedHillCrewState {
  readonly view: HillCrewStateView;
  readonly problem: string | null;
}

/** Parse the file's text. Total: no file is `here`, and anything that is not the shape reads as `here`. */
export function parseHillCrewState(text: string | null): ParsedHillCrewState {
  if (text === null) return { view: HILL_CREW_STATE_DEFAULT, problem: null };
  const doc = asJsonObject(parseJson(text));
  const state = doc?.state;
  const at = asJsonNumber(doc?.at);
  const by = asJsonString(doc?.by);
  const told = doc?.told === undefined ? null : asJsonNumber(doc.told);
  if (doc?.v !== 1 || !isHillCrewState(state) || at === undefined || !Number.isSafeInteger(at) || by === undefined || told === undefined || (told !== null && (!Number.isSafeInteger(told) || told < 0))) {
    return { view: HILL_CREW_STATE_DEFAULT, problem: `${HILL_CREW_STATE_FILE} is not a version 1 crew state file; the crew state reads as here` };
  }
  return { view: { state, at, by: headerField(by, BY_MAX), told }, problem: null };
}

/** The file's text for one value. */
export function renderHillCrewState(view: { readonly state: HillCrewState; readonly at: number; readonly by: string; readonly told: number | null }): string {
  const doc = view.told === null ? { v: 1, state: view.state, at: view.at, by: view.by } : { v: 1, state: view.state, at: view.at, by: view.by, told: view.told };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Write the crew state: the hill folder at 0700, the file at 0600 through a temp sibling of its own, so a
 * reader never sees half a file. Throws when the folder or the file cannot be written.
 */
export function writeHillCrewState(stateDir: string, value: { readonly state: HillCrewState; readonly by: string; readonly at?: number; readonly told?: number | null }, now: number = Date.now()): void {
  const dir = hillDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = hillCrewStatePath(stateDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, renderHillCrewState({ state: value.state, at: value.at ?? now, by: headerField(value.by, BY_MAX), told: value.told ?? null }), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Read the crew state once, with no cache: what the CLI reads when no bridge answers. */
export function readHillCrewState(stateDir: string): ParsedHillCrewState {
  let text: string | null;
  try {
    text = readFileSync(hillCrewStatePath(stateDir), "utf8");
  } catch {
    text = null;
  }
  return parseHillCrewState(text);
}

/**
 * The bridge's crew state: read behind a stat check (the last reading is kept until the file moves), and
 * written by the phone's route and the socket. Synchronous, because the snapshot, a post and an answer
 * ask it on their own path.
 */
export class HillCrewStateFile {
  private seen: string | undefined;
  private current: HillCrewStateView = HILL_CREW_STATE_DEFAULT;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(`[hill] ${line}`),
    private readonly now: () => number = Date.now,
  ) {}

  /** The crew state now. */
  read(): HillCrewStateView {
    const path = hillCrewStatePath(this.stateDir);
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
      this.current = HILL_CREW_STATE_DEFAULT;
      return this.current;
    }
    const read = readHillCrewState(this.stateDir);
    if (read.problem !== null) this.warn(read.problem);
    this.current = read.view;
    return this.current;
  }

  /** Set the state, by whom. The value as it reads after the write, or null when it could not be written. */
  set(state: HillCrewState, by: string): HillCrewStateView | null {
    try {
      writeHillCrewState(this.stateDir, { state, by }, this.now());
    } catch (err) {
      this.warn(`could not write ${hillCrewStatePath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const now = this.read();
    return now.state === state ? now : null;
  }

  /**
   * Record that "Tell all sessions now" ran for the value set at `at`: the same value, `told` added. False
   * when the state moved since (`at` differs), it was told already, or the file could not be written.
   */
  markTold(at: number, count: number): boolean {
    const held = this.read();
    if (held.at !== at || held.by === null || held.told !== null) return false;
    try {
      writeHillCrewState(this.stateDir, { state: held.state, by: held.by, at, told: count }, this.now());
    } catch (err) {
      this.warn(`could not write ${hillCrewStatePath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.read().told === count;
  }

  /**
   * Write the final count of a tell over its first mark, for the value set at `at` only (C-S1: `told`
   * counts the sessions walky typed into, known once the sends settled). False when the state moved.
   */
  setTold(at: number, count: number): boolean {
    const held = this.read();
    if (held.at !== at || held.by === null || held.told === null) return false;
    try {
      writeHillCrewState(this.stateDir, { state: held.state, by: held.by, at, told: count }, this.now());
    } catch (err) {
      this.warn(`could not write ${hillCrewStatePath(this.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return this.read().told === count;
  }
}
