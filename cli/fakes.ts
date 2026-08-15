import { PackOpsStore } from "../bridge/pack/ops-store.ts";
import type { CliContext } from "./context.ts";
import { instanceSuffix } from "./context.ts";
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
export const STATE = "/state";

export interface FakeExec extends Exec {
  /**
   * `<tool> <args…>` for every call, in order. A {@link Exec.runIn} call is recorded with its
   * working directory prefixed — `<cwd>$ <tool> <args…>` — because for the build steps the cwd IS
   * the difference between installing the root tree and installing `web/`.
   */
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
  const answer = (tool: string, args: readonly string[], cwd?: string): ExecResult => {
    const line = (cwd === undefined ? "" : `${cwd}$ `) + [tool, ...args].join(" ");
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
    capture: (tool, args) => answer(tool, args),
    inherit: (tool, args) => answer(tool, args),
    runIn: (tool, args, cwd) => answer(tool, args, cwd),
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
  /** Destructive filesystem operations in order: `rm -rf <p>` / `mv <from> <to>`. Ordering is the assertion `build` lives or dies by. */
  ops: string[];
}

export function fakeFiles(seed: Record<string, string> = {}): FakeFiles {
  const entries = new Map<string, { text: string; mode?: number }>();
  for (const [p, text] of Object.entries(seed)) entries.set(p, { text });
  const undeletable = new Set<string>();
  const ops: string[] = [];
  // Paths are a flat set, so a "directory" is whatever entries sit under it — enough to model the
  // staging swap, whose whole content is `web/dist/**`.
  const under = (p: string): string[] =>
    [...entries.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  return {
    entries,
    undeletable,
    ops,
    exists: (p) => under(p).length > 0,
    read: (p) => entries.get(p)?.text ?? null,
    list: (p) => [
      ...new Set(
        [...entries.keys()]
          .filter((k) => k.startsWith(`${p}/`))
          .map((k) => k.slice(p.length + 1).split("/")[0]!),
      ),
    ],
    write: (p, text, mode) => void entries.set(p, { text, mode }),
    mkdirp: () => {},
    remove: (p) => {
      if (undeletable.has(p)) return;
      entries.delete(p);
    },
    removeTree: (p) => {
      ops.push(`rm -rf ${p}`);
      for (const k of under(p)) if (!undeletable.has(k)) entries.delete(k);
    },
    rename: (from, to) => {
      ops.push(`mv ${from} ${to}`);
      for (const k of under(from)) {
        const value = entries.get(k)!;
        entries.delete(k);
        entries.set(to + k.slice(from.length), value);
      }
    },
  };
}

/**
 * The ops store over an in-memory file — how the operator reached each member, with no disk. Kept
 * here rather than in one suite because three of them need it and none of them may write a real one.
 */
export function fakeOps(seed: Record<string, unknown> = {}): PackOpsStore & { contents: () => string | null } {
  let contents: string | null =
    Object.keys(seed).length === 0 ? null : `${JSON.stringify({ version: 1, members: seed }, null, 2)}\n`;
  const store = new PackOpsStore("/state", {
    read: async () => contents,
    write: async (_p, data) => {
      contents = data;
    },
  }) as PackOpsStore & { contents: () => string | null };
  store.contents = () => contents;
  return store;
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
  // The default fixture is the solo instance, so every existing verb suite keeps asserting the
  // unsuffixed names. `{ instance: "v1" }` through `over` also moves the ownership record, exactly as
  // `loadContext` does — a fixture where it did not would be asserting a collision that cannot happen.
  const instance = over.instance ?? null;
  return {
    root: ROOT,
    instance,
    configDir: CONFIG,
    home: HOME,
    env,
    port: 8787,
    serveMode: "https",
    socket: "/home/pat/.config/herdr/herdr.sock",
    handlerFile: `${CONFIG}/tailscale-managed-handler${instanceSuffix(instance)}`,
    stateDir: STATE,
    ...over,
  };
}
