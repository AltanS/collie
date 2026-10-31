// What the canary needs to know about one agent to drive it: how to start it, how to get past the
// startup screens it paints in a fresh project, how to clear a draft without risk, and how to leave.
// Nothing here judges a screen; Collie's readers do that (readers.ts).

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { CanaryAgent } from "../args";

export interface AgentProfile {
  readonly agent: CanaryAgent;
  /** The command whose first x.y.z is the installed version. */
  readonly versionCommand: readonly string[];
  /**
   * The shell line that starts the agent, at `cols` columns when given, else at the pane's own
   * width. `stty` sets the size the agent reads: Herdr does not resize the PTY of a pane nobody is
   * viewing, and nobody views the canary's panes. `bin` replaces the agent's own command word, for
   * `--via` (args.ts); absent, the agent's own binary on PATH starts.
   */
  launch(cols: number | null, bin?: string): string;
  /**
   * Keys that answer a screen the agent paints before its composer in a fresh project (the folder
   * trust question), or null when `texts` is not such a screen. Keys go out one answer per poll, and
   * the next poll re-reads before anything else is sent.
   */
  startupAnswer(texts: readonly string[]): readonly string[] | null;
  /** The keys that clear a typed, unsubmitted draft of `text`. Never Ctrl+C on Codex: on an empty
   *  composer it exits Codex. */
  clearKeys(text: string): readonly string[];
  /** The one-shot fallback when {@link clearKeys} left something behind, or null when there is none
   *  that is safe. */
  readonly clearFallback: readonly string[] | null;
  /** Typed into an empty composer and submitted to leave the agent. */
  readonly exitCommand: string;
  /** How long to wait between typing {@link exitCommand} and its Enter; 400 ms when absent. */
  readonly exitSettleMs?: number;
}

/** `clear`, then the size, then the agent: one shell line. */
export function launchLine(cols: number | null, command: string): string {
  return cols === null ? `clear; ${command}` : `clear; stty cols ${cols}; ${command}`;
}

/** A path as one shell word: as it is when it needs no quoting, else in single quotes. */
export function shellWord(word: string): string {
  return /^[\w./~+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** A PATH entry that a package runner put there (`bunx` and `npx` add every ancestor's `node_modules/.bin`). */
function isLocalBin(dir: string): boolean {
  return /(^|[\\/])node_modules[\\/]\.bin[\\/]*$/u.test(dir);
}

/**
 * The binary the canary measures, as an absolute path: the first executable `name` on `pathVar`,
 * skipping `node_modules/.bin` entries, or null. One rule for every agent. `bunx` puts a stray
 * `~/node_modules/.bin` in front of PATH, and a pi 1.1.0 there won over the pi the operator runs
 * (2026-10-31). The version is read from this path and the launch line calls this path, so the label
 * and the process cannot name two binaries. Same rule as the browser leg's `onPath` (web/e2e/rig/bins.ts).
 */
export function resolveBinary(name: string, pathVar: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "" || isLocalBin(dir)) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here: the next directory
    }
  }
  return null;
}

/** The profile's version command, run through `bin` in place of its command word. */
export function versionCommandThrough(profile: AgentProfile, bin: string): readonly string[] {
  return [bin, ...profile.versionCommand.slice(1)];
}

/** The same agent, started through `bin` instead of its own command word (`--via`). */
export function launchedThrough(profile: AgentProfile, bin: string): AgentProfile {
  return { ...profile, launch: (cols) => profile.launch(cols, shellWord(bin)) };
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One Backspace per character typed, plus slack for a paste placeholder or a stray space. Cursor
 *  is at the end of a fresh paste, so this deletes the whole draft and nothing else: a Backspace on
 *  an empty input box is a no-op in all four agents. */
export function backspaceSweep(text: string): string[] {
  const count = [...GRAPHEMES.segment(text)].length + 16;
  return Array.from({ length: count }, () => "Backspace");
}

/** The trimmed text of the row a select's pointer is on, or null when no row carries `pointer`. */
export function pointedRow(texts: readonly string[], pointer: string): string | null {
  for (const t of texts) {
    const trimmed = t.trim();
    if (trimmed.startsWith(pointer)) return trimmed.slice(pointer.length).trim();
  }
  return null;
}
