// The installed version of a harness, read from its binary (M56 spec 02). The profile says which
// command prints it and which expression finds it; the screen is never read. This is the same rule
// the canary uses (`installedVersion` in scripts/harness-canary/run.ts): run the version command with
// a short bound and take the first match in what it printed, on stdout or stderr. A command that will
// not run, or prints no version, gives null, and `profileFor` turns null into `provisional`.

import { statSync } from "node:fs";
import { homedir } from "node:os";

import { type Profile, versionFromOutput } from "../../web/src/lib/surface/profile.ts";
import { HOST, type Host } from "../host.ts";
import { boundedRun, createLoginPath, type LoginPath, type LoginPathDeps } from "../login-path.ts";
import { envGet, envKey, findTool } from "../tools.ts";

/** The version command alone ends inside this, killed at the cap ({@link boundedRun}); the whole read has {@link VERSION_READ_BUDGET_MS}. */
const VERSION_TIMEOUT_MS = 3_000;

/** Runs a command and returns what it printed, or null when it would not run. */
export type RunVersionCommand = (command: readonly string[]) => string | null;

const spawnVersionCommand: RunVersionCommand = (command) => {
  try {
    const run = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe", timeout: VERSION_TIMEOUT_MS });
    return `${run.stdout.toString()} ${run.stderr.toString()}`;
  } catch {
    return null;
  }
};

/** The version the profile's binary reports, or null when it cannot be read. */
export function binaryVersion(profile: Profile, run: RunVersionCommand = spawnVersionCommand): string | null {
  const output = run(profile.identity.versionCommand);
  return output === null ? null : versionFromOutput(profile, output);
}

/**
 * Reads a binary's version without blocking, or null. Injected so tests run no process. `pane` is the
 * program the pane runs for the harness (bridge/pane-binary.ts `PaneBinary.command`): `[file]` or
 * `[interpreter, script]`. Given, it runs in place of the profile's binary; absent, the PATH lookup does.
 */
export type AsyncVersionReader = (profile: Profile, pane?: readonly string[]) => Promise<string | null>;

/** Runs a resolved command with `path` as its PATH and returns what it printed, or null when it would not run. */
export type RunResolvedCommand = (argv: readonly string[], path: string | undefined) => Promise<string | null>;

/** `env` is the bridge's own environment, whose PATH is searched after the login shell's. */
export interface VersionReaderDeps extends LoginPathDeps {
  loginPath?: LoginPath;
  /** The binary's file on `path`, or null. Defaults to {@link findTool}. */
  resolve?: (binary: string, path: string | undefined) => string | null;
  run?: RunResolvedCommand;
}

/**
 * The login shell's PATH first, the bridge's own after it, each directory once. The login PATH wins
 * because launchd gives a LaunchAgent only `/usr/bin:/bin:/usr/sbin:/sbin`. The bridge's own stays
 * as the tail because a systemd unit sets a PATH of its own (`~/.config/systemd/user/collie*.service`),
 * and a directory only that PATH holds must not drop out of the search.
 */
export function mergePaths(login: string | undefined, own: string | undefined, host: Host = HOST): string | undefined {
  const parts = [login, own].flatMap((p) => (p === undefined ? [] : p.split(host.path.delimiter)));
  const seen = new Set<string>();
  const merged = parts.filter((d) => d !== "" && !seen.has(d) && seen.add(d));
  return merged.length === 0 ? undefined : merged.join(host.path.delimiter);
}

/**
 * Reads a binary's version without blocking, from the binary the operator's login shell would run.
 * The bridge's own PATH is not enough: launchd gives a LaunchAgent `/usr/bin:/bin:/usr/sbin:/sbin`,
 * where no agent lives, and every send on such a host read the version as unread. The login PATH
 * alone is not enough either: it drops a directory only the systemd unit's PATH holds. So the search
 * runs over the login PATH, then the bridge's own ({@link mergePaths}). That merged PATH goes to the
 * child as well, because a script agent (`#!/usr/bin/env node`) finds its interpreter on it.
 */
export function createVersionReader(deps: VersionReaderDeps = {}): AsyncVersionReader {
  const search = createBinarySearch(deps);
  const run = deps.run ?? spawnWithPath;
  return async (profile, pane) => {
    const found = await search(profile, pane);
    if (found === null) return null;
    const output = await run([found.binary, ...found.args], found.path);
    return output === null ? null : versionFromOutput(profile, output);
  };
}

/** Where a profile's version command resolves: the file, the rest of its argv and the PATH it was found on. */
interface BinaryFound {
  readonly binary: string;
  readonly args: readonly string[];
  readonly path: string | undefined;
}

/**
 * Whether the pane's program can stand in for the profile's binary: the version command starts with
 * that binary (`[binary, "--version"]`). A command that starts with another program is left to the PATH.
 */
export function readsOwnBinary(profile: Profile): boolean {
  return profile.identity.versionCommand[0] === profile.identity.binary;
}

/**
 * The one resolution rule for a profile's binary (see {@link createVersionReader}); null when nothing on
 * the PATH answers. With the pane's program (`pane`), that program's words replace the binary, and only
 * a bare interpreter name among them is searched on the PATH: the file the pane runs is the one read.
 */
function createBinarySearch(deps: VersionReaderDeps): (profile: Profile, pane?: readonly string[]) => Promise<BinaryFound | null> {
  const env = deps.env ?? process.env;
  const host = deps.host ?? HOST;
  const loginPath = deps.loginPath ?? createLoginPath({ ...deps, env, host });
  const resolve =
    deps.resolve ?? ((binary: string, path: string | undefined) => findTool(binary, { ...env, PATH: path }, homedir(), host));
  return async (profile, pane) => {
    const [command, ...args] = profile.identity.versionCommand;
    const path = mergePaths(await loginPath(), envGet(env, "PATH", host), host);
    const [head, ...rest] = pane !== undefined && readsOwnBinary(profile) ? pane : [];
    if (head !== undefined) {
      const file = host.path.isAbsolute(head) ? head : resolve(head, path);
      return file === null ? null : { binary: file, args: [...rest, ...args], path };
    }
    const binary = command === undefined ? null : resolve(command, path);
    return binary === null ? null : { binary, args, path };
  };
}

/** What a version command did, for a diagnosis: how it ended and what it said on stderr. */
export interface RunOutcome {
  /** The exit code, or null when the process was killed (the bound) or never ran. */
  readonly exitCode: number | null;
  /** Stdout and stderr joined, as {@link RunResolvedCommand} returns them. */
  readonly output: string;
  readonly stderr: string;
}

/** Runs a resolved command with `path` as its PATH and reports how it ended, or null when it would not run. */
export type RunResolvedDetailed = (argv: readonly string[], path: string | undefined) => Promise<RunOutcome | null>;

/** A harness's binary as the bridge would find it, and what its version command returned. */
export interface BinaryRead {
  /** The file the version command resolved to on the login PATH, or null when nothing answers: not installed. */
  readonly binary: string | null;
  /** The version the profile's expression found, or null. Always null with no binary. */
  readonly version: string | null;
  /** How the version command ended. Null with no binary, or when the command would not run. */
  readonly outcome: RunOutcome | null;
}

export interface BinaryReaderDeps extends VersionReaderDeps {
  runDetailed?: RunResolvedDetailed;
}

/**
 * Reads a binary the way {@link createVersionReader} does (same login PATH, same resolution, same
 * child PATH) and keeps what that reader throws away: the resolved file and how the command ended.
 * `collie doctor` uses it to tell "not installed" from "installed, but the version read failed".
 */
export function createBinaryReader(deps: BinaryReaderDeps = {}): (profile: Profile, pane?: readonly string[]) => Promise<BinaryRead> {
  const search = createBinarySearch(deps);
  const run = deps.runDetailed ?? spawnWithPathDetailed;
  return async (profile, pane) => {
    const found = await search(profile, pane);
    if (found === null) return { binary: null, version: null, outcome: null };
    const outcome = await run([found.binary, ...found.args], found.path);
    return {
      binary: found.binary,
      version: outcome === null ? null : versionFromOutput(profile, outcome.output),
      outcome,
    };
  };
}

const spawnWithPathDetailed: RunResolvedDetailed = async (argv, path) => {
  const env = path === undefined ? process.env : { ...process.env, [envKey(process.env, "PATH")]: path };
  // The same real bound as a send's read (#594): a killed command is `exitCode: null`, "did not finish in time".
  const done = await boundedRun(argv, env, VERSION_TIMEOUT_MS);
  return done === null ? null : { exitCode: done.code, output: `${done.out} ${done.err}`, stderr: done.err };
};

const spawnWithPath: RunResolvedCommand = async (argv, path) => {
  const env = path === undefined ? process.env : { ...process.env, [envKey(process.env, "PATH")]: path };
  const done = await boundedRun(argv, env, VERSION_TIMEOUT_MS);
  return done === null || done.code === null ? null : `${done.out} ${done.err}`;
};

/** The version command run with Bun.spawn, bounded by VERSION_TIMEOUT_MS, never blocking the event loop. */
export const spawnBinaryVersion: AsyncVersionReader = createVersionReader();

/** How long a version read is trusted before the next send reads it again. */
export const VERSION_CACHE_MS = 10 * 60_000;

/**
 * How long a version read that failed (no binary, no version in what it printed, or no answer inside
 * {@link VERSION_READ_BUDGET_MS}) stands before a send reads again (#594). Short, so a binary that was
 * slow once, or one the operator just put on PATH, is read again soon; long enough that a hanging
 * `--version` costs one send's `profile` gap a minute, not every send's. A read that succeeds replaces it.
 */
export const VERSION_FAILED_CACHE_MS = 60_000;

/**
 * The whole version read, the login shell's PATH and the version command together, ends inside this
 * budget, or reads as failed (null) for {@link VERSION_FAILED_CACHE_MS}. The send's own bound starts
 * after the read (the `profile` gap in a receipt's `gapsMs`), so this is the longest a send waits for
 * its profile. The login PATH is asked once per process and keeps going in the background when the
 * budget ends first; the next read after the failed window takes its answer.
 */
export const VERSION_READ_BUDGET_MS = 4_000;

/** The most versions the cache keeps, one per profile and program read. A safety bound: the oldest goes first. */
const VERSION_CACHE_MAX = 128;

/**
 * At most one fresh read of a pane's own program per pane inside this window. A pane that keeps
 * changing the file it runs (or its words) would otherwise start a version command on every send; over
 * the limit the send uses the PATH binary's version, as a pane with no evidence does.
 */
export const PANE_READ_INTERVAL_MS = 10_000;

/** The most panes whose last fresh read is remembered. A safety bound: the oldest goes first. */
const PANE_READS_MAX = 256;

/** What identifies a file's content for the cache: its change time and size, or null when it cannot be statted. */
export type FileStamp = (path: string) => { readonly mtimeMs: number; readonly size: number } | null;

const statStamp: FileStamp = (path) => {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

/** A version, and the pane's program that was read for it (undefined when the PATH binary was). */
export interface ProgramVersion {
  readonly version: string | null;
  readonly command: readonly string[] | undefined;
}

/**
 * A cache of the harness's version for the send path (M56 spec 05), keyed by the program read: the
 * profile and, when the pane's foreground process showed the harness's own file (bridge/pane-binary.ts),
 * that command plus the file's `mtimeMs` and size (the last word: the binary, or the script after an
 * interpreter), so a file replaced in place while the old process runs reads again; else the profile's
 * binary on the PATH. Two panes that run two copies of one harness read two versions, and two panes
 * that run one file share one read. The first send on a key waits for the version, so its status is
 * never guessed; later sends use the cached value for VERSION_CACHE_MS. A version that could not be
 * read is cached too, as null, for VERSION_FAILED_CACHE_MS, which `profileFor` turns into `provisional`
 * and the probed path. The cache is per bridge process, so per host; sends that ask while a read runs
 * share that read. A pane's own program starts at most one fresh read per {@link PANE_READ_INTERVAL_MS}.
 */
export class VersionCache {
  private readonly known = new Map<string, { version: string | null; at: number }>();
  private readonly reading = new Map<string, Promise<string | null>>();
  private readonly paneReads = new Map<string, number>();

  constructor(
    private readonly read: AsyncVersionReader = spawnBinaryVersion,
    private readonly now: () => number = () => Date.now(),
    private readonly budgetMs: number = VERSION_READ_BUDGET_MS,
    private readonly stamp: FileStamp = statStamp,
  ) {}

  /** The version of `profile`'s harness: of the pane's program `pane` when given, else of the PATH binary. */
  async versionOf(profile: Profile, pane?: readonly string[]): Promise<string | null> {
    return (await this.programVersion(profile, pane)).version;
  }

  /**
   * {@link versionOf}, and which program answered. `pane` is used only when its file can be statted and,
   * with a `paneId`, the pane has not started a fresh read inside {@link PANE_READ_INTERVAL_MS}; else the
   * PATH binary answers and `command` is undefined.
   */
  async programVersion(profile: Profile, pane?: readonly string[], paneId?: string): Promise<ProgramVersion> {
    const file = pane?.at(-1);
    const stamped = pane === undefined || file === undefined ? null : this.stamp(file);
    if (pane === undefined || stamped === null) return { version: await this.cached(profile, undefined, profile.id), command: undefined };
    const key = [profile.id, ...pane, stamped.mtimeMs, stamped.size].join("\u0000");
    if (!this.settled(key) && !this.reading.has(key) && !this.takePaneRead(paneId)) {
      return { version: await this.cached(profile, undefined, profile.id), command: undefined };
    }
    return { version: await this.cached(profile, pane, key), command: pane };
  }

  /** A good or failed read still standing for `key`. */
  private settled(key: string): boolean {
    const hit = this.known.get(key);
    return hit !== undefined && this.now() - hit.at <= (hit.version === null ? VERSION_FAILED_CACHE_MS : VERSION_CACHE_MS);
  }

  /** Records a fresh read for the pane, or says false when it started one inside the window. No pane id is no limit. */
  private takePaneRead(paneId: string | undefined): boolean {
    if (paneId === undefined) return true;
    const at = this.now();
    const last = this.paneReads.get(paneId);
    if (last !== undefined && at - last < PANE_READ_INTERVAL_MS) return false;
    this.paneReads.delete(paneId);
    this.paneReads.set(paneId, at);
    if (this.paneReads.size > PANE_READS_MAX) {
      const oldest = this.paneReads.keys().next();
      if (!oldest.done) this.paneReads.delete(oldest.value);
    }
    return true;
  }

  private async cached(profile: Profile, pane: readonly string[] | undefined, key: string): Promise<string | null> {
    const hit = this.known.get(key);
    if (hit !== undefined && this.settled(key)) return hit.version;
    const running = this.reading.get(key);
    if (running !== undefined) return running;
    const work = this.readInBudget(profile, pane).then((version) => {
      this.known.delete(key);
      this.known.set(key, { version, at: this.now() });
      if (this.known.size > VERSION_CACHE_MAX) {
        const oldest = this.known.keys().next();
        if (!oldest.done) this.known.delete(oldest.value);
      }
      this.reading.delete(key);
      return version;
    });
    this.reading.set(key, work);
    return work;
  }

  private async readInBudget(profile: Profile, pane: readonly string[] | undefined): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), this.budgetMs);
    });
    try {
      return await Promise.race([(pane === undefined ? this.read(profile) : this.read(profile, pane)).catch(() => null), late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
