import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";

import { collieBinary, HOST, type Host } from "../bridge/host.ts";
import { sweepAsides } from "./build.ts";
import { instanceSuffix } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { type LinkReader, realLinkFs } from "./link.ts";
import { type Exec, type Files, POWERSHELL_UTF8, type ProcessLookup, PROCESS_QUERY_TIMEOUT_MS, realExec } from "./sys.ts";
import { logFileName } from "./unit.ts";

// WINDOWS: THE TASK SCHEDULER SUPERVISOR'S OWN PIECES (M43 spec 05).
//
// Task Scheduler starts a task at logon and restarts a task that failed to START. It does not
// watch a program that exits later, so it cannot be the whole supervisor the way systemd and launchd
// are. The task therefore runs a launcher Collie owns, `collie _supervise`, and the launcher runs the
// bridge (`collie _exec-bridge`, the same process the other supervisors run) and relaunches it when
// it exits non-zero. It is the shape of `contrib/windows/collie-ctl.ps1`, first written by
// @JJLiebig (#71), whose restart path @mqmalagris taught `cli/` to read (PR 309). That script is
// retired; this file and the `taskscheduler` tier in `cli/lifecycle.ts` replace it.
//
// THE RECORD. The launcher writes which processes it owns to `<configDir>\collie-processes`, so
// `restart`, `stop` and `status` can find them: the task's own process is `conhost.exe`, and ending
// the task kills that one process only, never the launcher or the bridge below it (Windows 11 VM,
// 2026-10-02). Two formats exist:
//
//   1  `<launcher pid>|<bridge pid>`, written by the community script. Read for one release, so an
//      install that still runs it is ADOPTED, not duplicated: `start` re-registers the same task
//      name over it and replaces its launcher, and `restart` re-registers the task and leaves its
//      loop running.
//   2  `version=2 launcher=<pid> bridge=<pid>`, written here. One line, so a person can read it.
//
// In both, a bridge pid of `0` is the launcher between two launches.
//
// Everything here is a pure function or takes its seams as parameters, so `bun test` on Linux runs
// the Windows logic with `hostFor("win32")` and fakes. That proves the logic, not Windows: the
// spawn, the console and the process table are checked on the Windows VM.

/** The record format this file writes. Format 1 is the community script's. */
export const TASK_RECORD_VERSION = 2;

/** What the launcher recorded: which processes the supervisor owns right now. */
export interface TaskRecord {
  /** 1: the community script wrote it. 2: `collie _supervise` did. */
  readonly format: 1 | 2;
  readonly launcher: number;
  /** `0` while the launcher waits between two launches. */
  readonly bridge: number;
}

/** `<configDir>\collie-processes`, suffixed per instance like the pidfile. */
export function taskRecordPath(configDir: string, instance: string | null = null, host: Host = HOST): string {
  return host.path.join(configDir, `collie${instanceSuffix(instance)}-processes`);
}

/**
 * `<configDir>\collie-restart`, suffixed per instance like the record. `collie restart` writes it
 * just before it kills the bridge, and the launcher consumes it: a bridge that died with this file
 * fresh beside it was stopped on purpose, not crashed (see {@link restartRequested}).
 */
export function taskRestartPath(configDir: string, instance: string | null = null, host: Host = HOST): string {
  return host.path.join(configDir, `collie${instanceSuffix(instance)}-restart`);
}

/** How long a restart marker stays believable. A marker older than this was left by a kill that never happened. */
export const RESTART_MARKER_TTL_MS = 60_000;

/** The marker's text: when it was written, in milliseconds since the epoch. */
export const formatRestartMarker = (now: number): string => `${now}\n`;

/** The record as the launcher writes it: one line. */
export function formatTaskRecord(launcher: number, bridge: number): string {
  return `version=${TASK_RECORD_VERSION} launcher=${launcher} bridge=${bridge}\n`;
}

/**
 * Either format, or `null` when the text is neither. Never throws: a byte-order mark, CRLF and blank
 * padding are read through (PowerShell writes the first two); an empty file, a torn write, an unknown
 * `version=3`, two lines or a UTF-16 file are all `null`, "no record", and every caller then trusts
 * only the process table. `bridge=0` is a record: the launcher between two launches.
 */
export function parseTaskRecord(text: string): TaskRecord | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const legacy = /^(\d+)\|(\d+)$/.exec(trimmed);
  if (legacy !== null) return { format: 1, launcher: Number(legacy[1]), bridge: Number(legacy[2]) };
  const own = /^version=2 launcher=(\d+) bridge=(\d+)$/.exec(trimmed);
  return own === null ? null : { format: 2, launcher: Number(own[1]), bridge: Number(own[2]) };
}

// ── A Windows command line, read back ────────────────────────────────────────

/**
 * Split a Windows command line into words, by the rules `CommandLineToArgvW` and every MSVCRT program
 * (Bun included) apply: blanks separate words outside quotes; `2n` backslashes before a quote are `n`
 * backslashes and the quote toggles quoting; `2n+1` are `n` and a literal quote; a backslash anywhere
 * else is literal. The inverse of `windowsArg` in `cli/unit.ts`, so a task's argument string can be
 * read back the way the launcher will receive it.
 */
export function parseWindowsArgs(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let slashes = 0;
  for (const ch of line) {
    if (ch === "\\") {
      slashes++;
      inWord = true;
      continue;
    }
    if (ch === '"') {
      word += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2 === 1) word += '"';
      else quoted = !quoted;
      slashes = 0;
      inWord = true;
      continue;
    }
    word += "\\".repeat(slashes);
    slashes = 0;
    if ((ch === " " || ch === "\t") && !quoted) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  word += "\\".repeat(slashes);
  if (inWord) words.push(word);
  return words;
}

// ── Whose process is this? ───────────────────────────────────────────────────

/** Windows paths compare without regard to case or separator, as the OS resolves them. */
export const windowsPathKey = (s: string): string => s.replaceAll("\\", "/").toLowerCase();

/**
 * Collapse the version directory of a binary install (`…/versions/<v>/bin/collie.exe`) so a launcher
 * started from one version still recognises a bridge started from another. The same rule as
 * `isOurBridge` in `cli/lifecycle.ts`, over a folded path. The task runs `…/current/bin/collie.exe`
 * (the junction an update moves), and the process table names that path as it was started, not the
 * folder behind it (Windows 11 VM, 2026-10-02), so `current` before `bin/collie` collapses the same way.
 */
const collapseVersion = (key: string): string =>
  key.replace(/\/versions\/[^/\s"]+\//, "/").replace(/\/current\/(?=bin\/collie)/, "/");

/**
 * Is `commandLine` this install's `collie <role>`? The binary path (folded, version collapsed), the
 * role word, and the instance marker in both directions: a suffixed instance demands its own
 * `--instance <name>`, the solo one demands none.
 */
export function isOwnWindowsProcess(
  commandLine: string,
  binary: string,
  role: "_exec-bridge" | "_supervise",
  instance: string | null,
): boolean {
  const line = collapseVersion(windowsPathKey(commandLine));
  if (!line.includes(collapseVersion(windowsPathKey(binary))) || !line.includes(role)) return false;
  return instance === null
    ? !/--instance(\s|=)/.test(commandLine)
    : new RegExp(`--instance(\\s+|=)"?${instance}"?(\\s|$)`).test(commandLine);
}

/** The community script's own path in a checkout. Named only to recognise its running launcher. */
const legacyScript = (root: string, host: Host): string =>
  host.path.join(root, "contrib", "windows", "collie-ctl.ps1");

/**
 * Is `commandLine` the launcher of this checkout, in the shape `format` says wrote the record?
 * Format 1 is the community script's loop (`powershell … collie-ctl.ps1 … _exec-bridge`); its file is
 * gone from the checkout after this release, and the running process still names it.
 */
export function isTaskLauncher(
  commandLine: string,
  format: 1 | 2,
  root: string,
  instance: string | null,
  host: Host,
): boolean {
  if (format === 2) return isOwnWindowsProcess(commandLine, collieBinary(root, host), "_supervise", instance);
  const line = windowsPathKey(commandLine);
  return line.includes(windowsPathKey(legacyScript(root, host))) && line.includes("_exec-bridge");
}

/**
 * Is `commandLine` a bridge of this checkout? Two shapes: `collie.exe _exec-bridge`, which a
 * `collie.exe` install and the launcher here both run, and `bun run <root>\bridge\index.ts`, which a
 * source checkout under the community script runs. Pids are recycled and the record outlives its
 * process, so a kill is justified by the process table, never by the record alone.
 */
export function isTaskBridge(commandLine: string, root: string, instance: string | null, host: Host): boolean {
  if (isOwnWindowsProcess(commandLine, collieBinary(root, host), "_exec-bridge", instance)) return true;
  return windowsPathKey(commandLine).includes(windowsPathKey(host.path.join(root, "bridge", "index.ts")));
}

// ── The registered task, read back ───────────────────────────────────────────

/** What Task Scheduler holds under a task name: its state and the program its action runs. */
export interface TaskQuery {
  /** `Ready`, `Running`, `Disabled`, as Task Scheduler names it, in English whatever the locale. */
  readonly state: string;
  /** The program that runs: the binary under `conhost --headless`, or the action's own command. */
  readonly program: string;
  readonly args: readonly string[];
}

/** Who the registered task belongs to. */
export type TaskOwner = "collie" | "legacy" | "foreign";

/** The PowerShell that reads one task: three lines, state, command, arguments, in UTF-8 (see {@link POWERSHELL_UTF8}). */
export function taskQueryScript(name: string): string {
  return `${POWERSHELL_UTF8}$t = Get-ScheduledTask -TaskName '${name.replaceAll("'", "''")}' -ErrorAction Stop; $a = @($t.Actions)[0]; [string]$t.State; [string]$a.Execute; [string]$a.Arguments`;
}

/** The three lines {@link taskQueryScript} prints, read back. `null` when there is no state line. */
export function parseTaskQuery(stdout: string, host: Host): TaskQuery | null {
  const [state = "", command = "", argline = ""] = stdout.split(/\r?\n/);
  if (state.trim() === "") return null;
  const words = parseWindowsArgs(argline);
  const underConhost = host.path.basename(command.trim()).toLowerCase() === "conhost.exe" && words[0] === "--headless";
  return underConhost
    ? { state: state.trim(), program: words[1] ?? "", args: words.slice(2) }
    : { state: state.trim(), program: command.trim(), args: words };
}

/**
 * Ask Task Scheduler for a task, through PowerShell because `schtasks /Query` prints the state in the
 * system's language. `undefined` when there is no PowerShell to ask, `null` when no such task exists.
 */
export function queryTask(exec: Pick<Exec, "capture">, name: string, host: Host): TaskQuery | null | undefined {
  const r = exec.capture("powershell", ["-NoProfile", "-NonInteractive", "-Command", taskQueryScript(name)], PROCESS_QUERY_TIMEOUT_MS);
  if (!r.found) return undefined;
  return r.code === 0 ? parseTaskQuery(r.stdout, host) : null;
}

/**
 * Whose task is this? `collie` when it runs this install's `collie.exe _supervise` (a binary install's
 * version folder may differ, as in {@link isOwnWindowsProcess}); `legacy` when it still runs this
 * checkout's community script; `foreign` for anything else, another checkout above all.
 */
export function taskOwner(query: TaskQuery, root: string, host: Host): TaskOwner {
  const fold = (p: string): string => collapseVersion(windowsPathKey(p));
  if (query.args[0] === "_supervise" && fold(query.program) === fold(collieBinary(root, host))) return "collie";
  const script = windowsPathKey(legacyScript(root, host));
  return query.args.some((word) => windowsPathKey(word) === script) ? "legacy" : "foreign";
}

// ── The launcher: `collie _supervise` ────────────────────────────────────────

/**
 * The pause before a relaunch starts at 5 s (systemd's `RestartSec=5`, launchd's `ThrottleInterval`,
 * the script's fixed 5 s) and doubles on every failure in a row, up to a minute. A bridge that dies at
 * once, say on a port another process holds, then costs a log line a minute instead of twelve. A
 * bridge that ran for {@link HEALTHY_RUN_MS} before it failed starts the ladder again at 5 s.
 */
export const RELAUNCH_DELAY_MIN_MS = 5_000;
export const RELAUNCH_DELAY_MAX_MS = 60_000;
/** How long a bridge must have lived for its failure to count as a fresh one, not part of a crash loop. */
export const HEALTHY_RUN_MS = 60_000;
/** The step the real launcher sleeps its pause in, so a restart marker is seen within half a second. */
export const PAUSE_STEP_MS = 500;

/** One bridge the launcher started. */
export interface LaunchedBridge {
  readonly pid: number;
  /** Its exit code once it has exited. A bridge killed by a signal reads as a failure. */
  readonly exited: Promise<number>;
}

export interface SuperviseDeps {
  readonly io: Io;
  readonly files: Pick<Files, "write" | "remove" | "rename" | "list" | "read">;
  readonly host: Host;
  /** Reads the `current` junction the task names, before every launch (see {@link launchRoot}). */
  readonly link: LinkReader;
  /** This process's pid: the launcher half of the record. */
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
  sleep(ms: number): Promise<void>;
  /**
   * The pause before a relaunch is slept in steps of this many milliseconds, and the restart marker is
   * read after each one (see {@link cmdSupervise}). Absent: one sleep for the whole pause.
   */
  readonly pauseStepMs?: number;
  /** Milliseconds since the epoch: how long a bridge lived decides the next pause. */
  now(): number;
  /** Start the bridge, both streams appended to `logPath`. `null` when it never started. */
  launch(command: readonly string[], opts: { cwd: string; env: Record<string, string>; logPath: string }): LaunchedBridge | null;
  /** Append one line of the launcher's own to the log the operator reads with `collie logs`. */
  note(logPath: string, line: string): void;
  /**
   * Take the one-launcher guard named `pipe` and hold it until this process ends (see
   * {@link supervisePipeName}). `held`: it is ours now. `taken`: another live process holds it.
   * `unguarded`: the guard could not be made at all, and `why` says how.
   */
  holdGuard(pipe: string): Promise<GuardAnswer>;
  /** The process table's answer for one pid: who holds a taken guard ({@link guardHolder}). */
  lookup(pid: number): ProcessLookup;
}

export type GuardAnswer = { readonly kind: "held" } | { readonly kind: "taken" } | { readonly kind: "unguarded"; readonly why: string };

// ── One launcher per instance ────────────────────────────────────────────────
//
// Task Scheduler's `IgnoreNew` sees only the task's own process, `conhost.exe`. Ending the task kills
// conhost alone, so the launcher and the bridge live on while the task reads `Ready`, and the
// five-minute revive trigger then starts a second launcher. That one overwrote the record, so
// `restart` and `update` acted on it while the first bridge kept the port and kept answering, and an
// update rolled back for nothing. The launcher therefore holds a named pipe server for its whole
// life. Windows lets one process create a pipe name first (`FILE_FLAG_FIRST_PIPE_INSTANCE`, which
// libuv sets), so a second launcher's listen fails with `EADDRINUSE`, and the name is free again the
// moment the holder dies, however it dies. Node's `fs` cannot open a file with an exclusive share
// mode, so a lock file could not do this. Checked on the Windows 11 VM with Bun 1.4.2, 2026-10-03.

/** How many times a launcher asks for the guard, {@link GUARD_RETRY_MS} apart, before it believes another holds it. */
export const GUARD_TRIES = 10;
/** The pause between two asks: `stop` + `start` can start this launcher while the killed one still dies. */
export const GUARD_RETRY_MS = 300;

/**
 * `\\.\pipe\collie-supervise-<instance>-<hash>`. Pipe names are one namespace for the whole machine,
 * every user and session, so the name also carries a hash of the record's path: another account's
 * Collie, or another install of the same instance name, has its own guard.
 */
export function supervisePipeName(recordPath: string, instance: string | null): string {
  const hash = createHash("sha256").update(recordPath.toLowerCase()).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\collie-supervise-${instance ?? "default"}-${hash}`;
}

/** How many times a record write is tried when Windows holds the file open (`EBUSY`, `EPERM`). */
export const RECORD_WRITE_TRIES = 5;

/**
 * Write the record ATOMICALLY: the whole line to a temporary file beside it, then a rename over the
 * record. A reader (`collie stop`, `restart`, `status`) therefore sees the old line or the new one,
 * never half of one. On Windows the rename fails while another process holds the record open without
 * delete sharing (PowerShell's `Get-Content` does), so a busy answer is retried with a short pause. A
 * record that still cannot be written is noted and skipped: the bridge keeps running, and the
 * readers fall back on the process table.
 */
async function writeRecord(deps: SuperviseDeps, path: string, logPath: string, text: string): Promise<void> {
  const temp = `${path}.${deps.pid}.tmp`;
  deps.files.write(temp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      deps.files.rename(temp, path);
      return;
    } catch (e) {
      // SAFETY: the assertion asserts nothing. `catch` binds `unknown`; a Node errno error carries a
      // string `code`, and any other value reads `undefined` here, which is the "not busy" answer.
      const code = (e as { code?: string }).code;
      const busy = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (!busy || attempt >= RECORD_WRITE_TRIES) {
        deps.files.remove(temp);
        deps.note(logPath, `could not write ${path} (${code ?? "error"}); the record is stale until the next launch`);
        return;
      }
      await deps.sleep(50 * attempt);
    }
  }
}

/**
 * The folder a launch runs from. On a binary install the task names `<install-root>\current`, a
 * junction, and this is the version folder it names AT THIS MOMENT. The bridge then runs from that
 * folder, with that folder as its root, exactly as the systemd unit and the plist run it, so
 * `collie update` and the identity checks see the layout they expect. The answer is never kept:
 * the launch after an update's `restart` reads the junction again and starts the new version. Any
 * other root, a checkout above all, is used as it is.
 */
export function launchRoot(root: string, link: LinkReader, host: Host): string {
  const probe = link.probe(root);
  return probe.kind === "symlink" ? host.path.resolve(host.path.dirname(root), probe.target) : root;
}

/**
 * `current` can be missing at launcher start: an update or a rollback was stopped between removing
 * the old junction and renaming the new one into place (`flipJunction` in `cli/update.ts`). When
 * `.current.new` is there, that flip is finished now, because it names the version the update had
 * already checked. When it is not, nothing on disk says which version `current` named, so nothing is
 * guessed: one loud line names the versions on disk and the command that repairs it, and the launch
 * that follows fails and is retried with backoff until an operator acts. `null` when there is
 * nothing to say. Only a root named `current` is touched, which a checkout never is.
 */
export function healCurrent(root: string, deps: Pick<SuperviseDeps, "files" | "link" | "host">): string | null {
  const p = deps.host.path;
  if (p.basename(root).toLowerCase() !== "current" || deps.link.probe(root).kind !== "absent") return null;
  const installRoot = p.dirname(root);
  const staged = p.join(installRoot, ".current.new");
  const probe = deps.link.probe(staged);
  if (probe.kind === "symlink") {
    try {
      deps.files.rename(staged, root);
      return `${root} was missing; finished the interrupted flip: ${staged} is now ${root} (${probe.target})`;
    } catch (err) {
      return `WARNING: ${root} is missing, and renaming ${staged} into its place failed (${String(err)}). Repair it by hand: cmd /c mklink /J "${root}" "${probe.target}"`;
    }
  }
  const versionsDir = p.join(installRoot, "versions");
  const versions = deps.files.list(versionsDir);
  if (versions.length === 0) return null;
  return (
    `WARNING: ${root} is missing and nothing on disk says which version it named, so the launcher does not guess. ` +
    `Versions on disk: ${versions.join(", ")}. Pick one, then run: cmd /c mklink /J "${root}" "${p.join(versionsDir, "<version>")}"`
  );
}

/**
 * Did `collie restart` stop this bridge? Reads the marker and removes it either way, so one marker
 * answers one exit. Only a marker written in the last {@link RESTART_MARKER_TTL_MS} counts: an older
 * one was left by a restart whose kill did not happen, and must not turn a later crash into a
 * "restart".
 */
export function restartRequested(deps: Pick<SuperviseDeps, "files" | "now">, path: string): boolean {
  const text = deps.files.read(path);
  if (text === null) return false;
  deps.files.remove(path);
  const at = Number(text.trim());
  const age = deps.now() - at;
  return Number.isFinite(at) && age >= 0 && age <= RESTART_MARKER_TTL_MS;
}

/** What `_supervise` was told on its command line. */
export interface SuperviseArgs {
  readonly instance: string | null;
  /** The `KEY=value` words: the bridge's environment, paths only. */
  readonly env: Readonly<Record<string, string>>;
}

/** `[--instance <name>] KEY=value…`, as `superviseArgs` in `cli/unit.ts` writes it. `null` on anything else. */
export function parseSuperviseArgs(args: readonly string[]): SuperviseArgs | null {
  let instance: string | null = null;
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--instance") {
      const name = args[i + 1];
      if (name === undefined) return null;
      instance = name;
      i++;
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (pair === null) return null;
    env[pair[1]!] = pair[2]!;
  }
  return { instance, env };
}

/**
 * The launcher. Runs the bridge, records both pids, and relaunches a bridge that exits non-zero after
 * a pause that backs off ({@link RELAUNCH_DELAY_MIN_MS}); a bridge that exits 0 chose to stop, and the launcher stops with it
 * (systemd's `Restart=on-failure`). `restart` relies on this loop: it kills the bridge ALONE, because
 * the phone's Update button runs `collie update` as a detached child of the bridge, and anything that
 * took the launcher's whole tree down would end that update half way through its own restart (#213).
 *
 * Returns only when the bridge exits 0, or at once with exit 2 when its arguments are unusable.
 */
export async function cmdSupervise(deps: SuperviseDeps, args: readonly string[]): Promise<number> {
  // Off Windows the service manager runs `_exec-bridge` itself; a launcher here would be a second,
  // unwatched supervisor. One line, nothing touched.
  if (deps.host.platform !== "win32") {
    deps.io.err("error: _supervise is the Windows Task Scheduler launcher; here the service manager runs the bridge");
    return EXIT.USAGE;
  }
  const parsed = parseSuperviseArgs(args);
  const root = parsed?.env.COLLIE_PLUGIN_ROOT;
  const configDir = parsed?.env.HERDR_PLUGIN_CONFIG_DIR;
  if (parsed === null || root === undefined || configDir === undefined) {
    deps.io.err("error: _supervise needs COLLIE_PLUGIN_ROOT=<dir> and HERDR_PLUGIN_CONFIG_DIR=<dir>; Task Scheduler runs it, not you");
    return EXIT.USAGE;
  }
  const { instance } = parsed;
  const record = taskRecordPath(configDir, instance, deps.host);
  const restartMarker = taskRestartPath(configDir, instance, deps.host);
  const logPath = deps.host.path.join(configDir, logFileName(instance));

  // Before the record is touched: a second launcher must not overwrite the first one's pids.
  const guard = await takeGuard(deps, supervisePipeName(record, instance));
  if (guard.kind === "taken") {
    // libuv reports EVERY refused pipe create as EADDRINUSE, a pipe another account made first
    // included. So "taken" is believed only when the record names a live launcher of this install;
    // anything else holding the name must not keep the bridge down for good (the revive trigger
    // would start, and stop, a launcher every five minutes forever).
    const holder = guardHolder(deps, record, root, instance);
    if (holder.kind === "launcher") {
      deps.note(logPath, `another Collie launcher (pid ${holder.pid}) already runs for this instance; this one exits`);
      return EXIT.OK;
    }
    if (holder.kind === "unknown") {
      deps.note(logPath, `the guard pipe is taken and the process list did not answer (${holder.why}); this launcher exits and the next try asks again`);
      return EXIT.OK;
    }
    deps.note(logPath, "another process holds the guard pipe and is not a Collie launcher, running unguarded");
  }
  if (guard.kind === "unguarded") deps.note(logPath, `could not take the one-launcher guard (${guard.why}); running without it`);

  let delay = RELAUNCH_DELAY_MIN_MS;
  // The pause is slept in steps, and the restart marker is read after each one. A `collie restart`
  // that arrives during a long pause then relaunches at once and starts the ladder again. Without
  // this, an update that rolls back from a bridge that crashed on start found the launcher in a pause
  // of up to a minute, longer than the rollback's own health check waits.
  const pause = async (): Promise<void> => {
    let left = delay;
    delay = Math.min(delay * 2, RELAUNCH_DELAY_MAX_MS);
    while (left > 0) {
      const step = Math.min(deps.pauseStepMs ?? left, left);
      await deps.sleep(step);
      left -= step;
      if (restartRequested(deps, restartMarker)) {
        delay = RELAUNCH_DELAY_MIN_MS;
        deps.note(logPath, "`collie restart` asked for a relaunch during the pause; relaunching now");
        return;
      }
    }
  };
  for (;;) {
    await writeRecord(deps, record, logPath, formatTaskRecord(deps.pid, 0));
    const healed = healCurrent(root, deps);
    if (healed !== null) deps.note(logPath, healed);
    const at = launchRoot(root, deps.link, deps.host);
    // A rebuilt checkout leaves its old binary aside while an old process still runs it
    // (`swapBinary`). The bridge that ran it is gone by now, so its aside goes before the next launch.
    sweepAsides(deps.files, collieBinary(at, deps.host), deps.host);
    const command = [collieBinary(at, deps.host), "_exec-bridge", ...(instance === null ? [] : ["--instance", instance])];
    const env = { ...deps.env, ...parsed.env, COLLIE_PLUGIN_ROOT: at };
    // The exact program, every time: on a binary install the path names a version folder, and this
    // line is how an operator sees which version the launcher really runs after an update.
    deps.note(logPath, `launching ${command.join(" ")} in ${at}`);
    const started = deps.now();
    const bridge = deps.launch(command, { cwd: at, env, logPath });
    if (bridge === null) {
      deps.note(logPath, `could not start ${command[0]}; trying again in ${delay / 1000}s`);
      await pause();
      continue;
    }
    await writeRecord(deps, record, logPath, formatTaskRecord(deps.pid, bridge.pid));
    const code = await bridge.exited;
    if (code === 0) {
      // Nothing left to own: a record naming two dead pids would only be re-examined by every verb.
      deps.files.remove(record);
      return EXIT.OK;
    }
    await writeRecord(deps, record, logPath, formatTaskRecord(deps.pid, 0));
    // A kill on Windows reads as exit 1, the same as a crash. The marker tells them apart: a bridge
    // `collie restart` stopped is relaunched at once and starts the ladder again, so the backoff can
    // never eat the health check an update runs right after its restart.
    if (restartRequested(deps, restartMarker)) {
      delay = RELAUNCH_DELAY_MIN_MS;
      deps.note(logPath, `the bridge (pid ${bridge.pid}) was stopped by \`collie restart\`; relaunching now`);
      continue;
    }
    if (deps.now() - started >= HEALTHY_RUN_MS) delay = RELAUNCH_DELAY_MIN_MS;
    deps.note(logPath, `the bridge (pid ${bridge.pid}) exited ${code}; relaunching in ${delay / 1000}s`);
    await pause();
  }
}

/** Who holds a taken guard: the live launcher the record names, nobody we can name, or no answer. */
type GuardHolder = { readonly kind: "launcher"; readonly pid: number } | { readonly kind: "stranger" } | { readonly kind: "unknown"; readonly why: string };

/**
 * The record's launcher, when it is alive and its command line is a launcher of THIS install (the
 * same check `stop` makes before it kills one). A record that is missing, names a dead pid or
 * another program, or a launcher of another install: a stranger.
 */
function guardHolder(deps: SuperviseDeps, recordPath: string, root: string, instance: string | null): GuardHolder {
  const text = deps.files.read(recordPath);
  const record = text === null ? null : parseTaskRecord(text);
  if (record === null || record.launcher <= 1 || record.launcher === deps.pid) return { kind: "stranger" };
  const found = deps.lookup(record.launcher);
  if (found.kind === "unknown") return { kind: "unknown", why: found.why };
  if (found.kind === "gone") return { kind: "stranger" };
  return isTaskLauncher(found.command, record.format, root, instance, deps.host) ? { kind: "launcher", pid: record.launcher } : { kind: "stranger" };
}

/** Ask for the guard up to {@link GUARD_TRIES} times: a launcher killed a moment ago may still hold it. */
async function takeGuard(deps: SuperviseDeps, pipe: string): Promise<GuardAnswer> {
  for (let attempt = 1; ; attempt++) {
    const answer = await deps.holdGuard(pipe);
    if (answer.kind !== "taken" || attempt >= GUARD_TRIES) return answer;
    await deps.sleep(GUARD_RETRY_MS);
  }
}

/** The real guard: a named pipe server, unreferenced, so it never keeps a finished launcher alive. */
export function holdGuardPipe(pipe: string): Promise<GuardAnswer> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (err) => {
      // SAFETY: the assertion asserts nothing. A listen error is a Node errno error with a string
      // `code`; any other value reads `undefined`, which is the "could not be made" answer.
      const code = (err as { code?: string }).code;
      // Only `EADDRINUSE` is "another launcher". Anything else must not keep the bridge down.
      resolve(code === "EADDRINUSE" ? { kind: "taken" } : { kind: "unguarded", why: `${code ?? "error"}: ${err.message}` });
    });
    server.listen(pipe, () => {
      // The runtime keeps a listening handle open until the process ends, unreferenced or not.
      server.unref();
      resolve({ kind: "held" });
    });
  });
}

/** The launcher's real seams: Node's spawn, the real filesystem, the real clock. */
export function realSuperviseDeps(io: Io, files: Pick<Files, "write" | "remove" | "rename" | "list" | "read">): SuperviseDeps {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    io,
    files,
    host: HOST,
    link: realLinkFs,
    pid: process.pid,
    env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pauseStepMs: PAUSE_STEP_MS,
    now: () => Date.now(),
    holdGuard: holdGuardPipe,
    lookup: (pid) => realExec(env, homedir()).processLookup(pid, PROCESS_QUERY_TIMEOUT_MS),
    launch(command, opts) {
      const [program, ...rest] = command;
      if (program === undefined) return null;
      mkdirSync(HOST.path.dirname(opts.logPath), { recursive: true });
      // Append, never truncate: the log of the run before a crash is the one an operator needs.
      const fd = openSync(opts.logPath, "a");
      try {
        // Not detached: the bridge shares the launcher's headless console, so it opens no window.
        const child = spawn(program, rest, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, fd], windowsHide: true });
        const exited = new Promise<number>((resolve) => {
          child.once("error", () => resolve(1));
          // A bridge ended by a signal (`TerminateProcess` on Windows) has no code: it failed.
          child.once("exit", (code) => resolve(code ?? 1));
        });
        return child.pid === undefined ? null : { pid: child.pid, exited };
      } catch {
        return null;
      } finally {
        closeSync(fd);
      }
    },
    note(logPath, line) {
      try {
        mkdirSync(HOST.path.dirname(logPath), { recursive: true });
        const fd = openSync(logPath, "a");
        try {
          writeSync(fd, `[collie supervisor ${new Date().toISOString()}] ${line}\n`);
        } finally {
          closeSync(fd);
        }
      } catch {
        // A log line that cannot be written must not stop the loop that keeps the bridge up.
      }
    },
  };
}
