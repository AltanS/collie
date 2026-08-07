import type { CliContext } from "./context.ts";
import type { Io } from "./io.ts";
import type { Exec, ExecResult, Files } from "./sys.ts";

// Fakes for the two seams every verb reaches the world through (cli/sys.ts), shared by the verb
// suites. TEST-ONLY: nothing under `cli/` that ships imports this, so it never reaches the compiled
// binary — and no test may reach a real service manager, tailnet or checkout through it.
//
// This is also the safety boundary the M3 milestone is run under. `bun test ./cli` must never
// dispatch a lifecycle, serve or uninstall verb at the host it runs on; a fake `Exec` is how.

export const ROOT = "/opt/collie";
export const BINARY = "/opt/collie/bin/collie";
export const CONFIG = "/cfg";
export const HOME = "/home/pat";
export const HANDLER_FILE = `${CONFIG}/tailscale-managed-handler`;

export interface FakeExec extends Exec {
  /** `<tool> <args…>` for every call, in order. */
  calls: string[];
  killed: number[];
  spawned: { command: string[]; env: Record<string, string>; logPath: string }[];
}

export interface Scripted {
  /** Tools that are not installed. */
  absent?: string[];
  /** Per-call answers, by `<tool> <args…>` prefix match; the first matching entry wins. */
  answers?: [prefix: string, answer: Partial<ExecResult> | ((n: number) => Partial<ExecResult>)][];
  /** The process table, for `ps -p <pid> -o command=`. */
  ps?: Record<number, string>;
  /** pid handed back by a detached spawn. */
  spawnPid?: number | null;
}

export function fakeExec(scripted: Scripted = {}): FakeExec {
  const calls: string[] = [];
  const killed: number[] = [];
  const spawned: { command: string[]; env: Record<string, string>; logPath: string }[] = [];
  const absent = new Set(scripted.absent ?? []);
  const seen = new Map<string, number>();
  const answer = (tool: string, args: readonly string[]): ExecResult => {
    const line = [tool, ...args].join(" ");
    calls.push(line);
    if (absent.has(tool)) return { code: 127, stdout: "", stderr: "", found: false };
    for (const [prefix, a] of scripted.answers ?? []) {
      if (!line.startsWith(prefix)) continue;
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      const resolved = typeof a === "function" ? a(n) : a;
      return { code: 0, stdout: "", stderr: "", found: true, ...resolved };
    }
    return { code: 0, stdout: "", stderr: "", found: true };
  };
  return {
    calls,
    killed,
    spawned,
    which: (tool) => (absent.has(tool) ? null : `/fake/${tool}`),
    capture: answer,
    inherit: answer,
    spawnDetached(command, opts) {
      spawned.push({ command: [...command], env: opts.env, logPath: opts.logPath });
      return scripted.spawnPid === undefined ? 4242 : scripted.spawnPid;
    },
    processCommand: (pid) => scripted.ps?.[pid] ?? null,
    kill: (pid) => void killed.push(pid),
  };
}

export interface FakeFiles extends Files {
  entries: Map<string, { text: string; mode?: number }>;
  /** Paths `remove` refuses to delete — the `rm -f` failures teardown must survive. */
  undeletable: Set<string>;
}

export function fakeFiles(seed: Record<string, string> = {}): FakeFiles {
  const entries = new Map<string, { text: string; mode?: number }>();
  for (const [p, text] of Object.entries(seed)) entries.set(p, { text });
  const undeletable = new Set<string>();
  return {
    entries,
    undeletable,
    exists: (p) => entries.has(p),
    read: (p) => entries.get(p)?.text ?? null,
    write: (p, text, mode) => void entries.set(p, { text, mode }),
    mkdirp: () => {},
    remove: (p) => {
      if (undeletable.has(p)) return;
      entries.delete(p);
    },
  };
}

export function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

export function context(
  env: Record<string, string | undefined> = {},
  over: Partial<CliContext> = {},
): CliContext {
  return {
    root: ROOT,
    configDir: CONFIG,
    home: HOME,
    env,
    port: 8787,
    serveMode: "https",
    socket: "/home/pat/.config/herdr/herdr.sock",
    handlerFile: HANDLER_FILE,
    ...over,
  };
}
