import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

// A pi extension that names the pane's session file on its herdr-core terminal (#809), based on
// @ibrmora's port of `omp-extension/collie-session-label.ts` (#675) in #780.
//
// herdr-core keeps a terminal's status but not its agent's conversation, so a pane whose folder holds
// a second pi or omp pane cannot be told apart by its folder (#508). Collie's pi journal already reads
// `pi.session_file` from the terminal's labels; this extension writes it and removes it when pi quits.
// The label is a best-effort lookup hint, never proof: the reader confines it to the harness's own log
// folder for that cwd and checks it as it would any session ref (ADR 0024).
//
// How pi differs from Oh My Pi:
//  - pi has no `session_switch` or `session_branch`. On `/new`, `/resume`, `/fork` and `/reload`, pi
//    emits `session_shutdown` (reason `new | resume | fork | reload`) on the old extension runtime,
//    tears it down, and emits `session_start` on a fresh runtime in the same process. Write state is
//    shared on `globalThis` per `HC_TERMINAL_ID` so replacement runtimes share one serialised queue and
//    remove the label only when `session_shutdown` carries `reason === "quit"`.
//  - pi waits for what a handler returns. This extension never makes it wait at the start of a session
//    or at the end of a turn: those handlers start the write and return at once. Only a quit waits for
//    the queue, because the process is about to end, and `hc` gets 1.5 s at most. A failed or hung `hc`
//    never throws into pi. The `hc` child and its timer hold pi's process open while that wait lasts,
//    so a quick `hc` ends the wait at once and a hung one is killed at the limit: pi can take up to 1.5 s
//    longer to quit.
//  - A session with no file (`--no-session`) writes the empty value at start. That is harmless and
//    clears an old label. After `/new` and `/fork` the label names a file that pi writes only at the
//    first reply.
//  - pi's bash tool injects `PI_SESSION_ID` into every shell it spawns, never into pi's own root env,
//    so an inherited `PI_SESSION_ID` marks a nested pi.
//  - `pi --mode rpc` sets `hasUI: true` with `mode: "rpc"`, so TUI gating checks `mode === undefined ||
//    mode === "tui"` in addition to `hasUI === true`.
//
// Install: copy this file into `~/.pi/agent/extensions/`, then start pi again.

/** The herdr-core terminal label whose value is the session's `.jsonl` path. */
export const SESSION_FILE_LABEL = "pi.session_file";

/** The part of a session's context this extension reads. */
export interface SessionContext {
  readonly hasUI?: boolean;
  readonly mode?: string;
  readonly sessionManager?: { getSessionFile?(): string | undefined };
}

/** A session event's payload (`reason` distinguishes `"quit"` from `/new`, `/resume`, `/fork`, `/reload`). It may be missing. */
export interface SessionEvent {
  readonly reason?: string;
}

/** The pi events this extension listens to. */
export type LabelledEvent = "session_start" | "agent_end" | "session_shutdown";

/** The part of pi's extension API this extension uses. Pi awaits a promise a handler returns; only a quit returns one. */
export interface ExtensionApi {
  on(event: LabelledEvent, handler: (event: SessionEvent | undefined, ctx: SessionContext | undefined) => Promise<void> | void): void;
}

/** Runs `hc` with these arguments and answers whether it succeeded. A runner that throws or rejects counts as not written. */
export type HcRunner = (args: readonly string[]) => Promise<boolean>;

/** Shared across replacement extension runtimes of one pi process (`wanted` newest, `written` last acked). */
export interface LabelState {
  wanted: string;
  written: string | undefined;
  queue: Promise<void>;
}

declare global {
  var __colliePiSessionLabel: Map<string, LabelState> | undefined;
}

function defaultStore(): Map<string, LabelState> {
  globalThis.__colliePiSessionLabel ??= new Map<string, LabelState>();
  return globalThis.__colliePiSessionLabel;
}

function stateFor(store: Map<string, LabelState>, terminal: string): LabelState {
  const existing = store.get(terminal);
  if (existing !== undefined) return existing;
  const created: LabelState = { wanted: "", written: undefined, queue: Promise.resolve() };
  store.set(terminal, created);
  return created;
}

/** Only the interactive TUI root pi of a terminal labels it (`rpc` also sets `hasUI: true`). */
function interactive(ctx: SessionContext | undefined): boolean {
  try {
    return ctx?.hasUI === true && (ctx.mode === undefined || ctx.mode === "tui");
  } catch {
    return false;
  }
}

/** The session's file as an absolute path, or "" when it has none (`--no-session`). */
export function sessionFileOf(ctx: SessionContext | undefined): string {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return file !== undefined && isAbsolute(file) ? file : "";
  } catch {
    return "";
  }
}

/**
 * Hook the events when this pi is the root TUI agent of a herdr-core terminal, and answer whether it
 * did. `env`, `run` and `shared` default to the process's own in production. The handlers of
 * `session_start` and `agent_end` start the write and return at once, so pi never waits for `hc`
 * there. A quit returns the queue, so pi waits once, for at most the writes still pending and the
 * clear. No handler throws or rejects.
 */
export function activate(
  pi: ExtensionApi,
  env: Readonly<Record<string, string | undefined>>,
  run: HcRunner,
  shared: Map<string, LabelState> = defaultStore(),
): boolean {
  const terminal = env.HC_TERMINAL_ID;
  if (terminal === undefined || terminal === "") return false;
  if (env.PI_SESSION_ID !== undefined && env.PI_SESSION_ID !== "") return false;
  const state = stateFor(shared, terminal);
  const write = async (): Promise<void> => {
    const next = state.wanted;
    if (next === state.written) return;
    try {
      if (await run(["label", terminal, `${SESSION_FILE_LABEL}=${next}`])) state.written = next;
    } catch {
      // A runner that throws or rejects counts as not written; the next event tries again.
    }
  };
  const sync = (value: string): Promise<void> => {
    state.wanted = value;
    state.queue = state.queue.then(write, write);
    return state.queue;
  };
  const update = (_event: SessionEvent | undefined, ctx: SessionContext | undefined): undefined => {
    try {
      if (interactive(ctx)) void sync(sessionFileOf(ctx));
    } catch {
      // Do nothing: a label is only a hint.
    }
    return undefined;
  };
  pi.on("session_start", update);
  pi.on("agent_end", update);
  // Only a real quit clears the pane's label; `/new`, `/resume`, `/fork` and `/reload` hand over to the next runtime.
  // It clears by what this process wrote, not by `ctx`, which may be torn down by then. A pi that never
  // wrote (print, json, rpc) has nothing to clear.
  pi.on("session_shutdown", (event, _ctx) => {
    try {
      if (event?.reason !== "quit") return undefined;
      if (state.wanted === "" && (state.written === undefined || state.written === "")) return undefined;
      return sync("");
    } catch {
      return undefined;
    }
  });
  return true;
}

/** How long `hc` gets before it is killed. */
const HC_LIMIT_MS = 1500;

/**
 * `hc` on the PATH, or `COLLIE_HC_BIN` (an empty value counts as unset); 1.5 s at most. Never rejects.
 * The output is never read, so the child gets no pipes: a wrapper script that leaves a child behind
 * cannot hold the wait. At the limit the child is killed and the answer is `false` at once. The
 * child and the timer keep the process alive until then, on purpose: the host awaits this answer at a
 * quit, and a process that held nothing would end before the clear landed or the kill ran.
 */
function runHc(args: readonly string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => clearTimeout(timer);
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      stop();
      resolve(ok);
    };
    try {
      const child = spawn(process.env.COLLIE_HC_BIN || "hc", [...args], { stdio: "ignore" });
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child is gone already.
        }
        finish(false);
      }, HC_LIMIT_MS);
      child.on("error", () => finish(false));
      child.on("exit", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

export default function collieSessionLabel(pi: ExtensionApi): void {
  activate(pi, process.env, runHc);
}
