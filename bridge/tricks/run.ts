import { join } from "node:path";

import { HOST } from "../host.ts";
import { redactText } from "../redact.ts";
import { isEmbedded } from "../root.ts";

// ONE RUN OF A TRICK'S PROGRAM (M94 slice 01): spawn, feed the facts, read with caps, kill on time.
//
// The limits are the point of this file:
//   * 10 s, then the whole process GROUP is killed. The program is started as a group leader, so a
//     `sh -c` that started `curl` takes `curl` down with it. A program that starts long work must
//     detach it and return (design §3.2: long work is the program's to detach).
//   * 64 KiB of stdout, then the run FAILS and the group is killed: a document past the cap is refused
//     whole by the parser anyway, and reading on would let a runaway program fill the bridge's memory.
//   * 8 KiB of stderr is kept for the error line; the rest is read and dropped, so a chatty program
//     cannot block on a full pipe.
// Every byte that leaves this file has been through the secret mask (`redactText`), stdout before the
// parser sees it and stderr before a log line or the doctor row does.

/** How long one run may take. */
export const RUN_TIMEOUT_MS = 10_000;
/** The most stdout a run may print. The document cap of the schema, so the parser never sees more. */
export const STDOUT_CAP_BYTES = 64 * 1024;
/** The most stderr kept for the error line. */
export const STDERR_CAP_BYTES = 8 * 1024;

export interface RunSpec {
  /**
   * The manifest's `run` line. A single script path (`program.ts`) runs with Collie's own runtime; any
   * other line is run by the shell in `cwd` ({@link launchOf}).
   */
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** The facts document, written to stdin and then closed. */
  stdin: string;
  timeoutMs?: number;
  stdoutCap?: number;
  stderrCap?: number;
  /** The platform, for the shell. Default `HOST.platform` (bridge/host.ts). */
  platform?: NodeJS.Platform;
  /** The runtime a script line runs with. Default this process's own ({@link ownRuntime}). For a test. */
  runtime?: Runtime;
}

// ── THE TWO FORMS OF A RUN LINE (M94 review 4) ──────────────────────────────────────────────────
// `run = "program.ts"` (or `.js`, `.mjs`, `.mts`): one relative path to a script inside the trick
// folder, no shell words. It runs with Collie's own runtime: the compiled `collie` is a Bun executable,
// and with `BUN_BE_BUN=1` in its environment it behaves as the `bun` CLI. So the bridge spawns its own
// `process.execPath` on the script, with that one variable added to the scrubbed environment, and the
// trick needs no `bun` on the unit's PATH. Under plain `bun` (a source checkout, the tests) the
// executable already is bun, and the variable is left out. `--no-install` keeps Bun from fetching a
// package a bare import names: a script imports only relative files in its own folder and the
// `node:` and `bun:` built-ins.
//
// Every other `run` value is a shell command line, as it always was (`./legs.sh`, `bun x.ts`,
// `darius due --json`). `BUN_BE_BUN` never reaches one: env.ts never passes it, even when listed.

/** The script extensions a run line names to run with Collie's own runtime. */
export const RUNTIME_EXTENSIONS = ["ts", "js", "mjs", "mts"] as const;

/** One relative path, each segment starting with a letter, digit or `_` (no `..`, no dot folder), ending in a runtime extension. */
const RUNTIME_SCRIPT = /^(?:\.\/)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:ts|js|mjs|mts)$/;

/** The variable that turns a compiled Bun executable into the `bun` CLI. */
export const BUN_BE_BUN = "BUN_BE_BUN";

/** The script a run line names for Collie's own runtime (without a leading `./`), or null for a shell line. */
export function runtimeScript(command: string): string | null {
  if (!RUNTIME_SCRIPT.test(command)) return null;
  return command.startsWith("./") ? command.slice(2) : command;
}

/** The executable a script line runs with, and whether it is a compiled Collie (which needs `BUN_BE_BUN`). */
export interface Runtime {
  execPath: string;
  compiled: boolean;
}

/** This process's own runtime: the compiled `collie`, or the `bun` that runs a source checkout. */
export function ownRuntime(): Runtime {
  return { execPath: process.execPath, compiled: isEmbedded(Bun.main) };
}

/** What a run spawns: the argv and the environment. */
export interface Launch {
  argv: string[];
  env: Record<string, string>;
}

/**
 * How a run line starts, the one rule the bridge's runner and `collie trick check --run` share: a
 * script line runs with `runtime` (plus `BUN_BE_BUN=1` when it is compiled), any other line with the
 * shell. `env` is the scrubbed environment (env.ts); it is copied, never changed.
 */
export function launchOf(command: string, env: Record<string, string>, opts: { cwd: string; platform: NodeJS.Platform; runtime: Runtime }): Launch {
  const script = runtimeScript(command);
  if (script === null) return { argv: shellArgv(command, opts.platform), env };
  const argv = [opts.runtime.execPath, "--no-install", join(opts.cwd, script)];
  return { argv, env: opts.runtime.compiled ? { ...env, [BUN_BE_BUN]: "1" } : env };
}

/** How a run ended. Every text here is masked. */
export type RunOutcome =
  | { kind: "exited"; code: number; stdout: string; stderr: string; ms: number }
  | { kind: "timeout"; stderr: string; ms: number; limitMs: number }
  | { kind: "overflow"; stderr: string; ms: number }
  | { kind: "spawn-failed"; message: string; ms: number };

/** The argv that runs a `run` line: the shell, so `./legs.sh` and `bun program.ts` both work. */
export function shellArgv(command: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];
}

/** Kill the whole group the program leads. A group that is gone already is not an error. */
function killGroup(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      Bun.spawnSync(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group exited between the decision and the kill.
  }
}

/** Once the program has exited, how long a pipe its detached work still holds may stay open. */
export const PIPE_GRACE_MS = 250;

interface Capped {
  text: string;
  /** More bytes came than the cap allowed. */
  over: boolean;
}

/** A stream read to its end with a cap, which the runner can also cut short. */
interface CappedRead {
  done: Promise<Capped>;
  cancel(): void;
}

/**
 * Read a stream to its end, keeping at most `cap` bytes. `onOver` is called once, as soon as the cap
 * is passed, and with `stopAtCap` the reading stops there (stdout); without it the rest is drained and
 * dropped (stderr), so the child never blocks on a full pipe. `cancel` ends the read with what it has.
 */
function readCapped(stream: ReadableStream<Uint8Array>, cap: number, stopAtCap: boolean, onOver: () => void): CappedRead {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let over = false;
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  const done = (async (): Promise<Capped> => {
    for (;;) {
      if (cancelled) break;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        break;
      }
      if (next.done) break;
      const chunk = next.value;
      if (over) continue;
      if (kept + chunk.length > cap) {
        const room = cap - kept;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept = cap;
        over = true;
        onOver();
        if (stopAtCap) cancel();
        continue;
      }
      chunks.push(chunk);
      kept += chunk.length;
    }
    const bytes = new Uint8Array(kept);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { text: new TextDecoder().decode(bytes), over };
  })();
  return { done, cancel };
}

/**
 * Run a program once. Never throws: a spawn that fails, a timeout and an overflow are outcomes, and
 * the caller decides what each costs (the backoff in `service.ts`).
 *
 * A normal exit kills nothing: work the program started in the background and left running is the
 * program's choice. Its pipes get {@link PIPE_GRACE_MS} after the exit and are then let go, so a
 * background job that kept stdout open cannot hold the run open.
 */
export async function runProgram(spec: RunSpec): Promise<RunOutcome> {
  const platform = spec.platform ?? HOST.platform;
  const timeoutMs = spec.timeoutMs ?? RUN_TIMEOUT_MS;
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    const launch = launchOf(spec.command, spec.env, { cwd: spec.cwd, platform, runtime: spec.runtime ?? ownRuntime() });
    child = Bun.spawn(launch.argv, {
      cwd: spec.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // A group of its own, so the kill below reaches every process the program started.
      detached: platform !== "win32",
    });
  } catch (err) {
    return { kind: "spawn-failed", message: redactText(err instanceof Error ? err.message : String(err)), ms: elapsed() };
  }
  const pid = child.pid;
  let ended: "timeout" | "overflow" | null = null;
  const out = readCapped(child.stdout, spec.stdoutCap ?? STDOUT_CAP_BYTES, true, () => stop("overflow"));
  const err = readCapped(child.stderr, spec.stderrCap ?? STDERR_CAP_BYTES, false, () => {});
  function stop(why: "timeout" | "overflow"): void {
    if (ended !== null) return;
    ended = why;
    killGroup(pid, platform);
    // A process outside the group (one that called setsid) may still hold a pipe: let go of both.
    out.cancel();
    err.cancel();
  }
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      child.stdin.write(spec.stdin);
      await child.stdin.end();
    } catch {
      // The program closed stdin without reading it, which a program that needs no facts may do.
    }
    const code = await child.exited;
    grace = setTimeout(() => {
      out.cancel();
      err.cancel();
    }, PIPE_GRACE_MS);
    const [stdout, stderrRead] = await Promise.all([out.done, err.done]);
    const stderr = redactText(stderrRead.text);
    if (ended === "timeout") return { kind: "timeout", stderr, ms: elapsed(), limitMs: timeoutMs };
    if (ended === "overflow" || stdout.over) return { kind: "overflow", stderr, ms: elapsed() };
    return { kind: "exited", code, stdout: redactText(stdout.text), stderr, ms: elapsed() };
  } finally {
    clearTimeout(timer);
    if (grace !== undefined) clearTimeout(grace);
  }
}

/** `: <the last non-empty stderr line>`, or nothing. */
function tail(stderr: string): string {
  const last = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .findLast((l) => l !== "");
  return last === undefined ? "" : `: ${last}`;
}

/**
 * One masked line for the doctor row, the CLI and a part's `problem`: what went wrong, at most `max`
 * characters, the last non-empty stderr line after it when there is one.
 */
export function outcomeProblem(outcome: RunOutcome, max: number): string | null {
  const line = ((): string | null => {
    switch (outcome.kind) {
      case "spawn-failed":
        return `The program did not start: ${outcome.message}`;
      case "timeout":
        return `The program ran past ${Math.round(outcome.limitMs / 1000)} s and was stopped${tail(outcome.stderr)}`;
      case "overflow":
        return `The program printed more than ${STDOUT_CAP_BYTES / 1024} KiB and was stopped${tail(outcome.stderr)}`;
      case "exited":
        return outcome.code === 0 ? null : `The program exited with ${outcome.code}${tail(outcome.stderr)}`;
    }
  })();
  if (line === null) return null;
  const flat = line.replace(/[\p{Cc}]/gu, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
