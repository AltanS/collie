import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";

import { collieBinary, HOST, type Host } from "../bridge/host.ts";
import { instanceSuffix } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";
import { logFileName } from "./unit.ts";

// WINDOWS: THE TASK SCHEDULER SUPERVISOR'S OWN PIECES (M43 spec 05).
//
// Task Scheduler starts a task at logon and restarts a task that failed to START. It does not
// watch a program that exits later, so it cannot be the whole supervisor the way systemd and launchd
// are. The task therefore runs a launcher Collie owns, `collie _supervise`, and the launcher runs the
// bridge (`collie _exec-bridge`, the same process the other supervisors run) and relaunches it when
// it exits non-zero. It is the shape of `contrib/windows/collie-ctl.ps1`, first written by
// @Pimpmuckl (#71), whose restart path @mqmalagris taught `cli/` to read (PR 309). That script is
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

/** The record as the launcher writes it: one line. */
export function formatTaskRecord(launcher: number, bridge: number): string {
  return `version=${TASK_RECORD_VERSION} launcher=${launcher} bridge=${bridge}\n`;
}

/** Either format, or `null` when the text is neither. */
export function parseTaskRecord(text: string): TaskRecord | null {
  const trimmed = text.trim();
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
 * `isOurBridge` in `cli/lifecycle.ts`, over a folded path.
 */
const collapseVersion = (key: string): string => key.replace(/\/versions\/[^/\s"]+\//, "/");

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

// ── The launcher: `collie _supervise` ────────────────────────────────────────

/** The pause before a relaunch: systemd's `RestartSec=5`, launchd's `ThrottleInterval`, the script's 5 s. */
export const RELAUNCH_DELAY_MS = 5_000;

/** One bridge the launcher started. */
export interface LaunchedBridge {
  readonly pid: number;
  /** Its exit code once it has exited. A bridge killed by a signal reads as a failure. */
  readonly exited: Promise<number>;
}

export interface SuperviseDeps {
  readonly io: Io;
  readonly files: Pick<Files, "write" | "remove">;
  readonly host: Host;
  /** This process's pid: the launcher half of the record. */
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
  sleep(ms: number): Promise<void>;
  /** Start the bridge, both streams appended to `logPath`. `null` when it never started. */
  launch(command: readonly string[], opts: { cwd: string; env: Record<string, string>; logPath: string }): LaunchedBridge | null;
  /** Append one line of the launcher's own to the log the operator reads with `collie logs`. */
  note(logPath: string, line: string): void;
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
 * {@link RELAUNCH_DELAY_MS}; a bridge that exits 0 chose to stop, and the launcher stops with it
 * (systemd's `Restart=on-failure`). `restart` relies on this loop: it kills the bridge ALONE, because
 * the phone's Update button runs `collie update` as a detached child of the bridge, and anything that
 * took the launcher's whole tree down would end that update half way through its own restart (#213).
 *
 * Returns only when the bridge exits 0, or at once with exit 2 when its arguments are unusable.
 */
export async function cmdSupervise(deps: SuperviseDeps, args: readonly string[]): Promise<number> {
  const parsed = parseSuperviseArgs(args);
  const root = parsed?.env.COLLIE_PLUGIN_ROOT;
  const configDir = parsed?.env.HERDR_PLUGIN_CONFIG_DIR;
  if (parsed === null || root === undefined || configDir === undefined) {
    deps.io.err("error: _supervise needs COLLIE_PLUGIN_ROOT=<dir> and HERDR_PLUGIN_CONFIG_DIR=<dir>; Task Scheduler runs it, not you");
    return EXIT.USAGE;
  }
  const { instance } = parsed;
  const record = taskRecordPath(configDir, instance, deps.host);
  const logPath = deps.host.path.join(configDir, logFileName(instance));
  const command = [collieBinary(root, deps.host), "_exec-bridge", ...(instance === null ? [] : ["--instance", instance])];
  const env = { ...deps.env, ...parsed.env };

  for (;;) {
    deps.files.write(record, formatTaskRecord(deps.pid, 0));
    const bridge = deps.launch(command, { cwd: root, env, logPath });
    if (bridge === null) {
      deps.note(logPath, `could not start ${command[0]}; trying again in ${RELAUNCH_DELAY_MS / 1000}s`);
      await deps.sleep(RELAUNCH_DELAY_MS);
      continue;
    }
    deps.files.write(record, formatTaskRecord(deps.pid, bridge.pid));
    const code = await bridge.exited;
    if (code === 0) {
      // Nothing left to own: a record naming two dead pids would only be re-examined by every verb.
      deps.files.remove(record);
      return EXIT.OK;
    }
    deps.files.write(record, formatTaskRecord(deps.pid, 0));
    deps.note(logPath, `the bridge (pid ${bridge.pid}) exited ${code}; relaunching in ${RELAUNCH_DELAY_MS / 1000}s`);
    await deps.sleep(RELAUNCH_DELAY_MS);
  }
}

/** The launcher's real seams: Node's spawn, the real filesystem, the real clock. */
export function realSuperviseDeps(io: Io, files: Pick<Files, "write" | "remove">): SuperviseDeps {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    io,
    files,
    host: HOST,
    pid: process.pid,
    env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
