// ── THE PANE'S OWN PROGRAM: WHICH FILE A VERSION READ RUNS (ADR 0124, amended 2026-10-26) ─────────
//
// A send reads the harness's version to pick its profile status (ADR 0091 verified/provisional). That
// read used to run the binary the bridge's PATH finds. A pane can run another copy: an omp started by
// its full path, a per-project install, an nvm or bun copy, or the old program still running after an
// update. Its receipts then named the PATH binary's version, and its status was judged on that one
// (live check of 1.24.1, W5: an omp 18.12.6 pane read as 18.6.1, verified).
//
// So when the multiplexer reports the pane's foreground processes (`MuxAdapter.foregroundProcesses`,
// Herdr's `pane.process_info`), and one of them runs the pane's harness (`harnessProcessOf`, the launch
// window's argv grammar), the version read runs THAT program:
//
//  • argv[0] is the harness's binary: its file. An absolute argv[0] as it is; a relative one against
//    the process's folder; a bare name (the shell found it on its own PATH, which the bridge does not
//    know) by the process's executable, when the host shows it (`/proc/<pid>/exe` on Linux) and it is
//    not an interpreter: a program that renamed itself (`process.title`) runs as node or bun, and that
//    file prints the interpreter's version, not the agent's.
//  • argv[0] is an interpreter and an argument is the harness's script: the same interpreter (absolute,
//    the process's executable, or the bare name the version read resolves on its PATH) with the
//    script, made absolute against the process's folder.
//
// Anything it cannot make absolute is no evidence, and the PATH lookup stays: tmux, zellij and tuios
// have no foreground read, a read that fails or takes longer than FOREGROUND_READ_MS counts as none,
// and a host with no `/proc` keeps a bare name on the PATH lookup.
//
// One foreground read per send at most: {@link sharedForegroundRead} shares the read in flight and
// keeps its answer for {@link FOREGROUND_REUSE_MS}, so the launch window's read and the profile's read
// of one send are one call. No harness is named here: the binaries come from the profiles.

import { readlinkSync } from "node:fs";

import { findProfile, loadProfiles, profileForPlatform } from "../web/src/lib/surface/profile.ts";
import { HOST, type Host } from "./host.ts";
import type { ForegroundProcess } from "./journal/types.ts";
import { FOREGROUND_READ_MS, harnessProcessOf, isInterpreter } from "./launch-window.ts";
import type { VersionCache } from "./surface/binary-version.ts";
import type { PaneProfileMatch } from "./surface/protocol.ts";

/** How long one foreground read answers the next asker on the same pane: the reads of one send. */
export const FOREGROUND_REUSE_MS = 1_000;

/** The most panes whose last read is kept. A safety bound: the oldest goes first. */
const SHARED_MAX = 256;

/** What the multiplexer's foreground read answers, as `MuxAdapter.foregroundProcesses` does. */
export type ForegroundOutcome = { readonly ok: true; readonly value: readonly ForegroundProcess[] } | { readonly ok: false };

/** A pane's foreground read. */
export type ForegroundRead = (paneId: string) => Promise<ForegroundOutcome>;

/**
 * A multiplexer's foreground read, bounded by `bound` and shared per pane: a read in flight answers every
 * asker, and its answer stands for `reuseMs`. A refusal, a throw or a slow read answers `{ ok: false }`.
 * Undefined when the multiplexer has no such read.
 */
export function sharedForegroundRead(
  read: ((paneId: string) => Promise<ForegroundOutcome>) | undefined,
  options: { readonly bound?: number; readonly reuseMs?: number; readonly now?: () => number } = {},
): ForegroundRead | undefined {
  if (read === undefined) return undefined;
  const bound = options.bound ?? FOREGROUND_READ_MS;
  const reuseMs = options.reuseMs ?? FOREGROUND_REUSE_MS;
  const now = options.now ?? (() => Date.now());
  const kept = new Map<string, SharedRead>();
  return (paneId) => {
    const hit = kept.get(paneId);
    if (hit !== undefined && (hit.at === null || now() - hit.at <= reuseMs)) return hit.answer;
    const answer: Promise<ForegroundOutcome> = bounded(read, paneId, bound).then((outcome) => {
      const mine = kept.get(paneId);
      if (mine?.answer === answer) mine.at = now();
      return outcome;
    });
    kept.delete(paneId);
    kept.set(paneId, { answer, at: null });
    if (kept.size > SHARED_MAX) {
      const oldest = kept.keys().next();
      if (!oldest.done) kept.delete(oldest.value);
    }
    return answer;
  };
}

/** One pane's shared read: its answer, and when it came (null while it runs). */
interface SharedRead {
  readonly answer: Promise<ForegroundOutcome>;
  at: number | null;
}

async function bounded(read: (paneId: string) => Promise<ForegroundOutcome>, paneId: string, bound: number): Promise<ForegroundOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ForegroundOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), bound);
  });
  try {
    const answer = await Promise.race([read(paneId).catch((): ForegroundOutcome => ({ ok: false })), late]);
    return answer.ok ? { ok: true, value: answer.value } : { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** What the host shows of a running process: its executable and its folder, or null. */
export interface ProcessProbe {
  readonly exeOf: (pid: number) => string | null;
  readonly cwdOf: (pid: number) => string | null;
}

/** Linux's `/proc/<pid>/exe` and `/proc/<pid>/cwd`; null on every other host and on any error. */
export function procProbe(host: Host = HOST): ProcessProbe {
  const link = (pid: number, name: string): string | null => {
    if (host.platform !== "linux") return null;
    try {
      return readlinkSync(`/proc/${pid}/${name}`);
    } catch {
      return null;
    }
  };
  return { exeOf: (pid) => link(pid, "exe"), cwdOf: (pid) => link(pid, "cwd") };
}

/** The program a pane runs for a harness, as the version read runs it. */
export interface PaneBinary {
  /** The harness id the process matched. */
  readonly harness: string;
  /**
   * What runs in place of the profile's binary: `[file]`, or `[interpreter, script]`. Every word is an
   * absolute path, except an interpreter's bare name, which the version read resolves on its PATH.
   */
  readonly command: readonly string[];
}

const NO_PROBE: ProcessProbe = { exeOf: () => null, cwdOf: () => null };

/**
 * The program of the pane's harness among its foreground `processes`, made absolute (see the header),
 * or null when no process runs a known harness or its file cannot be told.
 */
export function paneBinaryOf(
  processes: readonly ForegroundProcess[],
  binaries: ReadonlyMap<string, string>,
  probe: ProcessProbe = NO_PROBE,
  host: Host = HOST,
): PaneBinary | null {
  const found = harnessProcessOf(processes, binaries);
  if (found === null) return null;
  const pid = found.process.pid;
  const exe = pid === undefined ? null : usable(probe.exeOf(pid));
  const cwd = (): string | null => (pid === undefined ? null : usable(probe.cwdOf(pid)));
  const [first] = found.process.argv;
  if (first === undefined) return null;
  if (found.script === undefined) {
    const file = absolute(first, cwd, host) ?? (bare(first, host) && exe !== null && !isInterpreter(exe) ? exe : null);
    return file === null ? null : { harness: found.harness, command: [file] };
  }
  // An interpreter's script is a file the interpreter opened from its folder, bare name or not.
  const script = host.path.isAbsolute(found.script) ? found.script : joinCwd(found.script, cwd, host);
  if (script === null) return null;
  const interpreter = absolute(first, cwd, host) ?? (exe !== null && isInterpreter(exe) ? exe : bare(first, host) ? first : null);
  return interpreter === null ? null : { harness: found.harness, command: [interpreter, script] };
}

/** A word with no separator: a name the shell looked up on its PATH. */
function bare(word: string, host: Host): boolean {
  return !word.includes("/") && (host.platform !== "win32" || !word.includes("\\"));
}

/** An absolute word as it is, a relative path (one with a separator) against the process's folder, else null. */
function absolute(word: string, cwd: () => string | null, host: Host): string | null {
  if (host.path.isAbsolute(word)) return word;
  return bare(word, host) ? null : joinCwd(word, cwd, host);
}

function joinCwd(word: string, cwd: () => string | null, host: Host): string | null {
  const folder = cwd();
  return folder === null ? null : host.path.resolve(folder, word);
}

/** A probe answer a version read can run: Linux marks a file gone since the start ` (deleted)`. */
function usable(path: string | null): string | null {
  return path === null || path.endsWith(" (deleted)") ? null : path;
}

export interface PaneProfileDeps {
  readonly versions: Pick<VersionCache, "versionOf">;
  /** Each profile's binary (lower case) to its harness id, as the launch window matches them. */
  readonly binaries: () => ReadonlyMap<string, string>;
  readonly probe?: ProcessProbe;
  readonly platform?: string;
  readonly host?: Host;
}

/**
 * The send path's profile lookup (`SendDeps.profile`): a harness's profile at its version, null when the
 * harness has none. With a pane and a foreground read, a foreground process that runs THIS harness
 * gives the program read, and the match names its file (`binary`); a read that shows none of it, or
 * no read, leaves the PATH binary. A harness with no profile reads nothing at all.
 */
export function createPaneProfile(deps: PaneProfileDeps): (harness: string, paneId?: string, foreground?: ForegroundRead) => Promise<PaneProfileMatch | null> {
  const platform = deps.platform ?? HOST.platform;
  return async (harness, paneId, foreground) => {
    const profile = findProfile(loadProfiles(), harness);
    if (profile === undefined) return null;
    const read = paneId === undefined || foreground === undefined ? undefined : await foreground(paneId);
    const pane = read?.ok === true ? paneBinaryOf(read.value, deps.binaries(), deps.probe, deps.host) : null;
    const command = pane !== null && pane.harness === profile.id ? pane.command : undefined;
    const match = profileForPlatform(profile.id, await deps.versions.versionOf(profile, command), platform);
    const binary = command?.at(-1);
    return match === null || binary === undefined ? match : { ...match, binary };
  };
}
