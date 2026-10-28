// The pure decisions of rig.ts: which cgroup may own a rig, the scope's name and limits, the settings read
// from the environment, how the command line splits, and whether the daemon's start needs the plain spawn.
// Node builtins only, no reads of /proc or /sys, no side effects: `scripts/browser-leg-rig-scope.test.ts`
// imports this file on every platform. rig.ts does the reading and passes the text in.
import { createHash } from "node:crypto";

export const DEFAULT_TASKS_MAX = 700;
export const DEFAULT_TASKS_MAX_CREW = 1400;
/** The scope's longest life: 6 hours. A hard stop by systemd, with no teardown. */
export const DEFAULT_RUNTIME_MAX_SEC = 21_600;
export const DEFAULT_MAX_PANES = 6;
/** `rig-<8 hex>-<pid>.scope`: the only unit name rig.ts ever stops. */
export const SCOPE_NAME = /^rig-[0-9a-f]+-[0-9]+\.scope$/;
/** A slice name `COLLIE_RIG_SLICE` may hold: systemd's own characters, ending in `.slice`. */
export const SLICE_NAME = /^[A-Za-z0-9_.@:-]+\.slice$/;
/** How long after the start a non-zero exit of systemd-run still counts as systemd-run's own failure. */
export const SYSTEMD_RUN_FAIL_MS = 1500;
/** The owner check misses in a row that tear the rig down. */
export const OWNER_MISSES_TO_TEARDOWN = 2;
/** What systemd-run prints (without -q) once the scope exists, before it replaces itself with the command: "Running scope as unit:" in older systemd, "Running as unit:" in newer. */
const SCOPE_STARTED_LINE = /Running (scope )?as unit:/;

/** A positive integer written in plain digits ("1e3", "0x10", "7.5", "0" and "" are not), else undefined. */
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** COLLIE_RIG_TASKS_MAX when it is a positive integer, else the default for a solo or a crew rig. */
export function scopeTasksMax(raw: string | undefined, crew: boolean): number {
  return positiveInt(raw) ?? (crew ? DEFAULT_TASKS_MAX_CREW : DEFAULT_TASKS_MAX);
}

/** COLLIE_RIG_RUNTIME_MAX_SEC when it is a positive integer, else 6 hours. */
export function scopeRuntimeMaxSec(raw: string | undefined): number {
  return positiveInt(raw) ?? DEFAULT_RUNTIME_MAX_SEC;
}

/** COLLIE_RIG_MAX_PANES when it is a positive integer, else 6. */
export function maxPanes(raw: string | undefined): number {
  return positiveInt(raw) ?? DEFAULT_MAX_PANES;
}

/** The slice to put the scope in: COLLIE_RIG_SLICE when it is a valid slice name, else null (systemd picks its default). */
export function sliceFrom(raw: string | undefined): string | null {
  return raw !== undefined && SLICE_NAME.test(raw) ? raw : null;
}

/** The 8 hex digits of the state root's hash: the middle of every scope name of that rig. */
export function stateRootHash(stateRoot: string): string {
  return createHash("sha1").update(stateRoot).digest("hex").slice(0, 8);
}

/** `rig-<8 hex of the state root>-<pid of the `up` that started it>.scope`. */
export function scopeUnitName(stateRoot: string, pid: number): string {
  return `rig-${stateRootHash(stateRoot)}-${pid}.scope`;
}

/**
 * The scope names of this state root in the output of `systemctl --user list-units 'rig-<hash>-*.scope'
 * --no-legend --plain`: the first word of each line, kept only when it is `rig-<hash>-<pid>.scope` for this
 * root's hash. Another rig's scope, a glob that matched too much and a stray word give nothing.
 */
export function scopeUnitsFrom(listUnits: string, stateRoot: string): string[] {
  const prefix = `rig-${stateRootHash(stateRoot)}-`;
  const found: string[] = [];
  for (const line of listUnits.split("\n")) {
    const name = line.trim().split(/\s+/)[0] ?? "";
    if (name.startsWith(prefix) && SCOPE_NAME.test(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The cgroup a /proc/self/cgroup text names, when it is a Claude session's scope (`claude-*.scope`): the
 * only unit known to end with the work in it. An allow list: a login session (`session-*.scope`), a desktop
 * app scope (`app-*.scope`), a `vte-spawn-*` or `tmux-spawn-*` scope and every other unit outlive or
 * outrun the work, so none is an owner. Null for anything else. The caller still checks that the directory
 * exists.
 */
export function ownerCgroupFrom(procSelfCgroup: string): string | null {
  const line = procSelfCgroup.split("\n").find((l) => l.startsWith("0::"));
  const path = line?.slice(3) ?? "";
  const leaf = path.split("/").pop() ?? "";
  if (!/^claude-.+\.scope$/.test(leaf)) return null;
  return path;
}

/** What one stat of the owner's cgroup directory showed: it is there, it is gone (ENOENT), or it could not be told. */
export type OwnerCheck = "present" | "gone" | "unknown";

/** What a failed stat of the owner's directory means: ENOENT is "gone"; any other error code (or none) is "unknown" and is ignored. */
export function ownerCheckOf(errorCode: string | undefined): OwnerCheck {
  return errorCode === "ENOENT" ? "gone" : "unknown";
}

/** The count of misses in a row after one check: a present owner resets it, a gone one adds, an unknown one changes nothing. */
export function nextOwnerMisses(misses: number, check: OwnerCheck): number {
  if (check === "present") return 0;
  return check === "gone" ? misses + 1 : misses;
}

/**
 * The `sh -c` script that runs the daemon inside the scope. `exec 2>&1` sends the daemon's stderr to its
 * stdout (daemon.out), so the file that holds systemd-run's stderr holds only systemd-run's own words.
 * Core dumps are off unless COLLIE_RIG_CORES=1.
 */
export function daemonScript(cores: boolean): string {
  return `exec 2>&1; ${cores ? "" : "ulimit -c 0; "}exec "$0" "$@"`;
}

/** What `up` saw of the systemd-run child by the time it looked. */
export interface StartObservation {
  /** The child exited: its code (null when a signal ended it) and the ms since the spawn. Null while it lives. */
  readonly exited: { readonly code: number | null; readonly afterMs: number } | null;
  /** The child could not be spawned at all (no such binary). */
  readonly spawnFailed: boolean;
  /** rig.json holds the child's pid: the daemon ran. */
  readonly daemonWrote: boolean;
  /** What systemd-run wrote to its stderr file. */
  readonly stderr: string;
}

/**
 * Whether the plain spawn may replace a systemd-run that did not give the daemon a scope. Only when
 * systemd-run itself failed: it exited non-zero within 1.5 s, the daemon never wrote rig.json, and its stderr
 * file holds words that are not the "Running scope" line of a scope that did start (bus and unit errors).
 * A child still alive is no failure, and one that ran the daemon has its own error to report: a second
 * daemon beside it would be two rigs.
 */
export function shouldFallBack(o: StartObservation): boolean {
  if (o.daemonWrote) return false;
  if (o.spawnFailed) return true;
  if (o.exited === null) return false;
  if (o.exited.code === 0 || o.exited.afterMs > SYSTEMD_RUN_FAIL_MS) return false;
  const text = o.stderr.trim();
  return text !== "" && !SCOPE_STARTED_LINE.test(text);
}

/** The warning when the scope's pids.max is not the cap asked for (null: it is). `read` is the file's text, or null when unreadable. */
export function taskCapWarning(read: string | null, expected: number): string | null {
  const got = read?.trim();
  if (got === String(expected)) return null;
  return `WARNING: the task cap is not enforced on the scope (pids.max is ${got === undefined || got === "" ? "unreadable" : got}, expected ${expected})`;
}

/** The arguments of a rig.ts call, split into the verb, the flags the rig reads, and what is left. */
export interface SplitArgs {
  readonly verb: string | undefined;
  /** The words after the verb that are not flags; for `pane` the command that reaches the pane, untouched. */
  readonly rest: readonly string[];
  readonly crew: boolean;
  readonly replace: boolean;
  /** The word after `--on`, or "" when there is none; null without the flag. */
  readonly on: string | null;
  /** A literal `--` stood after the verb: `rest` is the pane's command, even when it starts with `ls` or `close`. */
  readonly literal: boolean;
}

/**
 * Take `--crew`, `--replace` and `--on <machine>` out of the arguments. They count before the verb, and
 * after it for every verb but `pane`. For `pane` they count only before the first word of the command
 * (`ls` and `close` are verbs, so flags may follow them), or anywhere before a literal `--`. From
 * there on, and after `--`, every word reaches the pane as typed: `pane sh -c 'echo --replace'` keeps it.
 */
export function splitArgs(args: readonly string[]): SplitArgs {
  let verb: string | undefined;
  const rest: string[] = [];
  let crew = false;
  let replace = false;
  let on: string | null = null;
  let literal = false;
  let scanning = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (scanning) {
      if (arg === "--") {
        scanning = false;
        literal = verb !== undefined;
        continue;
      }
      if (arg === "--crew" || arg === "--replace") {
        if (arg === "--crew") crew = true;
        else replace = true;
        continue;
      }
      if (arg === "--on") {
        on = args[i + 1] ?? "";
        i += 1;
        continue;
      }
    }
    if (verb === undefined) {
      verb = arg;
      continue;
    }
    rest.push(arg);
    // The first word of a pane's command ends the flags; `pane ls` and `pane close` run no command, so theirs go on.
    if (verb === "pane" && rest[0] !== "ls" && rest[0] !== "close") scanning = false;
  }
  return { verb, rest, crew, replace, on, literal };
}

/** True when `open` panes already fill the cap `max`: no new pane may start. */
export function paneCapReached(open: number, max: number): boolean {
  return open >= max;
}
