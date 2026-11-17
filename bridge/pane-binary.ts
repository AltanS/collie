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
// Herdr's pid is trusted only when `/proc/<pid>/cmdline` is the argv Herdr reported ({@link ProcessProbe}):
// otherwise the executable and folder are not read, and only an absolute argv path can still be used.
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
// The version cache keys the file by its mtime and size, so a file replaced in place reads again, and
// allows a pane one fresh read of its own program per 10 s (bridge/surface/binary-version.ts).
//
// One foreground read per send at most: {@link sharedForegroundRead} shares the read in flight and
// keeps its answer for {@link FOREGROUND_REUSE_MS}, so the launch window's read and the profile's read
// of one send are one call. No harness is named here: the binaries come from the profiles.

import { readFileSync, readlinkSync } from "node:fs";

import { findProfile, loadProfiles, profileForPlatform, type Profile } from "../web/src/lib/surface/profile.ts";
import { HOST, paneSurfacePlatform, WSL_FLAGS, type Host } from "./host.ts";
import type { ForegroundProcess } from "./journal/types.ts";
import { FOREGROUND_READ_MS, harnessProcessOf, isInterpreter, type HarnessProcess } from "./launch-window.ts";
import type { ProgramVersion, VersionCache } from "./surface/binary-version.ts";
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

/** What the host shows of a running process: its argv, its executable and its folder, or null. */
export interface ProcessProbe {
  /** The process's own argv (`/proc/<pid>/cmdline`), the check that the pid is the process Herdr named. */
  readonly cmdlineOf: (pid: number) => readonly string[] | null;
  readonly exeOf: (pid: number) => string | null;
  readonly cwdOf: (pid: number) => string | null;
  /** The named variables of the process's environment (`/proc/<pid>/environ`), or null. Absent: none can be read. */
  // Only `names` leave the probe: an environment can hold secrets (API keys), so the rest is dropped here.
  readonly environOf?: (pid: number, names: readonly string[]) => ProcessEnvironment | null;
}

/** Some of a process's environment variables by name, as `/proc/<pid>/environ` holds them. */
export type ProcessEnvironment = Readonly<Record<string, string>>;

/**
 * The `names` among `/proc/<pid>/environ`'s NUL-separated `NAME=value` entries. Every other entry, and
 * the raw text, stay inside this function: never logged, stored or returned.
 */
export function envFromEnviron(raw: string, names: readonly string[]): ProcessEnvironment {
  const wanted = new Set(names);
  const pairs = argvFromCmdline(raw).flatMap((entry): Array<[string, string]> => {
    const at = entry.indexOf("=");
    if (at <= 0) return [];
    const name = entry.slice(0, at);
    return wanted.has(name) ? [[name, entry.slice(at + 1)]] : [];
  });
  return Object.fromEntries(pairs);
}

/** `/proc/<pid>/cmdline` as an argv: NUL-separated, each word ended by a NUL. */
export function argvFromCmdline(raw: string): string[] {
  const words = raw.split("\0");
  if (words.at(-1) === "") words.pop();
  return words;
}

/** Linux's `/proc/<pid>/cmdline`, `exe` and `cwd`; null on every other host and on any error. */
export function procProbe(host: Host = HOST): ProcessProbe {
  const link = (pid: number, name: string): string | null => {
    if (host.platform !== "linux") return null;
    try {
      return readlinkSync(`/proc/${pid}/${name}`);
    } catch {
      return null;
    }
  };
  const cmdline = (pid: number): readonly string[] | null => {
    if (host.platform !== "linux") return null;
    try {
      return argvFromCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  };
  const environ = (pid: number, names: readonly string[]): ProcessEnvironment | null => {
    if (host.platform !== "linux") return null;
    try {
      return envFromEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"), names);
    } catch {
      return null;
    }
  };
  return { cmdlineOf: cmdline, exeOf: (pid) => link(pid, "exe"), cwdOf: (pid) => link(pid, "cwd"), environOf: environ };
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

const NO_PROBE: ProcessProbe = { cmdlineOf: () => null, exeOf: () => null, cwdOf: () => null };

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
  // The pid is Herdr's word. `/proc/<pid>` answers for that process only when its own argv is the one
  // Herdr reported: another pid namespace, a reused pid, or a program that rewrote its title says
  // something else, and then its executable and folder are no evidence.
  const pid = provenPid(found.process, probe);
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

let binariesMemo: ReadonlyMap<string, string> | null = null;

/** Each profile's binary (lower case) to its harness id: the one table a foreground process is matched against. */
export function profileBinaries(): ReadonlyMap<string, string> {
  return (binariesMemo ??= new Map([...loadProfiles().values()].map((profile) => [profile.identity.binary.toLowerCase(), profile.id])));
}

/**
 * WHICH HARNESS RUNS IN THIS PANE, by its foreground program (#793). The one answer the send path and
 * the journal share, so the two cannot name a pane differently again.
 *
 * A process counts when the binary table names it exactly ({@link harnessProcessOf}: argv[0]'s program
 * name, or the script an interpreter runs). The answer is that harness, or null when:
 *  • no process is a known binary (a shell, `ssh`, a container, a wrapper the table does not know);
 *  • processes name two different harnesses: a wrong name types with the wrong keys, so none is better;
 *  • with a `probe`, every process of that harness has a pid whose `/proc/<pid>/cmdline` is not the argv
 *    the multiplexer reported (another pid namespace, a reused pid, a host with no `/proc`). A process
 *    the multiplexer reports with no pid counts on its argv alone.
 * `probe` null: argv alone, for a reader that types nothing (the journal picks which log to read by it).
 */
export function paneHarnessOf(processes: readonly ForegroundProcess[], binaries: ReadonlyMap<string, string>, probe: ProcessProbe | null): HarnessProcess | null {
  const found = processes.map((process) => harnessProcessOf([process], binaries)).filter((one): one is HarnessProcess => one !== null);
  if (new Set(found.map((one) => one.harness)).size !== 1) return null;
  if (probe === null) return found[0] ?? null;
  return found.find((one) => one.process.pid === undefined || provenPid(one.process, probe) !== undefined) ?? null;
}

/**
 * The send path's {@link paneHarnessOf} over the pane's shared foreground read (`SendDeps.paneHarness`):
 * the harness id, or null when the read fails or names none.
 */
export function createPaneHarness(deps: { readonly read: ForegroundRead; readonly binaries: () => ReadonlyMap<string, string>; readonly probe: ProcessProbe }): (paneId: string) => Promise<string | null> {
  return async (paneId) => {
    const read = await deps.read(paneId);
    return read.ok ? (paneHarnessOf(read.value, deps.binaries(), deps.probe)?.harness ?? null) : null;
  };
}

/**
 * WHAT STANDS IN A PANE'S FOREGROUND, for the blind road (M102 spec 12): a pane no profile reads.
 *  • `shell`: every foreground process is an interactive shell of {@link SHELL_NAMES}, with no script
 *    or command argument (flags only, a login shell's `-bash` included). The pane waits at a prompt.
 *  • `program`: any other foreground process (a shell running a child shows the child; `bash x.sh`
 *    and `bash -c …` run a script). It may be asking something.
 *  • `unknown`: no read (tmux, zellij, tuios and tern have none here; a read that fails or is slow), an
 *    empty list, or a process with no argv.
 */
export type PaneForeground = "shell" | "program" | "unknown";

/** The interactive shells, by program name (lower case, no `.exe`). Data, not a branch per shell. */
export const SHELL_NAMES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu", "xonsh", "elvish", "pwsh"]);

/** The pane's {@link PaneForeground} from its foreground processes. */
export function paneForegroundOf(processes: readonly ForegroundProcess[]): PaneForeground {
  if (processes.length === 0) return "unknown";
  const each = processes.map(foregroundOfOne);
  if (each.includes("unknown")) return "unknown";
  return each.every((one) => one === "shell") ? "shell" : "program";
}

function foregroundOfOne(process: ForegroundProcess): PaneForeground {
  const [first, ...rest] = process.argv;
  if (first === undefined || first.length === 0) return "unknown";
  // An interpreter that runs a shell's script (`python3 /usr/bin/xonsh`) is that shell.
  const [program, args] = isInterpreter(first) && rest[0] !== undefined ? [rest[0], rest.slice(1)] : [first, rest];
  return SHELL_NAMES.has(programName(program)) && args.every((arg) => arg.startsWith("-")) ? "shell" : "program";
}

/** A program's name: the last path part, a login shell's leading `-` and a `.exe` cut, lower case. */
function programName(word: string): string {
  const last = word.split(/[/\\]/u).at(-1) ?? word;
  return last.replace(/^-/u, "").replace(/\.exe$/iu, "").toLowerCase();
}

/** The send path's {@link paneForegroundOf} over the pane's shared foreground read (`SendDeps.paneForeground`). */
export function createPaneForeground(read: ForegroundRead): (paneId: string) => Promise<PaneForeground> {
  return async (paneId) => {
    const outcome = await read(paneId);
    return outcome.ok ? paneForegroundOf(outcome.value) : "unknown";
  };
}

/** The process's pid when `/proc/<pid>/cmdline` is the argv the multiplexer reported, else undefined. */
function provenPid(process: ForegroundProcess, probe: ProcessProbe): number | undefined {
  return process.pid !== undefined && sameArgv(probe.cmdlineOf(process.pid), process.argv) ? process.pid : undefined;
}

function sameArgv(seen: readonly string[] | null, reported: readonly string[]): boolean {
  return seen !== null && seen.length === reported.length && seen.every((word, i) => word === reported[i]);
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
  readonly versions: Pick<VersionCache, "programVersion">;
  /** Each profile's binary (lower case) to its harness id, as the launch window matches them. */
  readonly binaries: () => ReadonlyMap<string, string>;
  readonly probe?: ProcessProbe;
  readonly platform?: string;
  readonly host?: Host;
}

/**
 * A profile's version as a pane runs it, the one rule the send path and the Surface shadow share: with a
 * pane and a foreground read, a foreground process that runs THIS profile's harness gives the program
 * read; a read that shows none of it, or no read, leaves the PATH binary. The PATH binary alone misses a
 * harness the login shell does not put on the PATH (a bun or npm global added in an interactive rc
 * file), which the pane's own program still finds.
 */
/** A profile's version as a pane runs it ({@link createPaneVersion}). */
export type PaneVersion = (profile: Profile, paneId?: string, foreground?: ForegroundRead) => Promise<ProgramVersion>;

export function createPaneVersion(deps: PaneVersionDeps): PaneVersion {
  const now = deps.now ?? (() => Date.now());
  const lastGood = new Map<string, { readonly profileId: string; readonly answer: ProgramVersion; readonly at: number }>();
  return async (profile, paneId, foreground) => {
    const read = paneId === undefined || foreground === undefined ? undefined : await foreground(paneId);
    const pane = read?.ok === true ? paneBinaryOf(read.value, deps.binaries(), deps.probe, deps.host) : null;
    const command = pane !== null && pane.harness === profile.id ? pane.command : undefined;
    if (paneId !== undefined && command === undefined) {
      // No program of this agent on the pane now (it exited to the shell, or the read failed): the
      // program it ran a moment ago answers, so two sends a few seconds apart name one version.
      const kept = lastGood.get(paneId);
      if (kept !== undefined && kept.profileId === profile.id && now() - kept.at <= PANE_LAST_GOOD_MS) return kept.answer;
    }
    // The cache says which program answered: it falls back to the PATH binary for a file it cannot stat
    // and for a pane that read its own program a moment ago, and then no file is named.
    const answer = await deps.versions.programVersion(profile, command, paneId);
    if (paneId !== undefined && answer.command !== undefined && answer.version !== null) {
      lastGood.delete(paneId);
      lastGood.set(paneId, { profileId: profile.id, answer, at: now() });
      if (lastGood.size > LAST_GOOD_MAX) {
        const oldest = lastGood.keys().next();
        if (!oldest.done) lastGood.delete(oldest.value);
      }
    }
    return answer;
  };
}

export interface PaneVersionDeps extends Omit<PaneProfileDeps, "platform"> {
  readonly now?: () => number;
}

/**
 * How long a pane's last answer from its own program stands once the program is gone from the pane's
 * foreground. Long enough for the sends of one exchange, short enough that a new install the operator
 * starts in that pane is read.
 */
export const PANE_LAST_GOOD_MS = 30_000;

/** The most panes whose last answer is kept. A safety bound: the oldest goes first. */
const LAST_GOOD_MAX = 256;

/**
 * The send path's profile lookup (`SendDeps.profile`): a harness's profile at its version, null when the
 * harness has none. With a pane and a foreground read, a foreground process that runs THIS harness
 * gives the program read, and the match names its file (`binary`); a read that shows none of it, or
 * no read, leaves the PATH binary. A harness with no profile reads nothing at all.
 */
export function createPaneProfile(deps: PaneProfileDeps & { readonly paneVersion?: PaneVersion }): (harness: string, paneId?: string, foreground?: ForegroundRead) => Promise<PaneProfileMatch | null> {
  const platform = deps.platform ?? HOST.platform;
  const probe = deps.probe ?? NO_PROBE;
  const versionOf = deps.paneVersion ?? createPaneVersion(deps);
  // Under WSL the pane's agent decides its keys by its own environment (paneSurfacePlatform). The read
  // is the one the version read just made: the send path's foreground read is shared per pane.
  const platformOf = async (profileId: string, paneId?: string, foreground?: ForegroundRead): Promise<string> => {
    if (platform !== "wsl" || paneId === undefined || foreground === undefined) return platform;
    const read = await foreground(paneId);
    const found = read.ok ? harnessProcessOf(read.value, deps.binaries()) : null;
    if (found === null || found.harness !== profileId) return platform;
    const pid = provenPid(found.process, probe);
    return paneSurfacePlatform(platform, pid === undefined ? null : (probe.environOf?.(pid, WSL_FLAGS) ?? null));
  };
  return async (harness, paneId, foreground) => {
    const profile = findProfile(loadProfiles(), harness);
    if (profile === undefined) return null;
    const answer = await versionOf(profile, paneId, foreground);
    const match = profileForPlatform(profile.id, answer.version, await platformOf(profile.id, paneId, foreground));
    const binary = answer.command?.at(-1);
    return match === null || binary === undefined ? match : { ...match, binary };
  };
}
