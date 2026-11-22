import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

// A pi extension that names the pane's session file on its herdr-core terminal (#809), based on
// ibrmora's port of `omp-extension/collie-session-label.ts` (#675) in #780.
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

/** A session event's payload (`reason` distinguishes `"quit"` from `/new`, `/resume`, `/fork`, `/reload`). */
export interface SessionEvent {
  readonly reason?: string;
}

/** The pi events this extension listens to. */
export type LabelledEvent = "session_start" | "agent_end" | "session_shutdown";

/** The part of pi's extension API this extension uses. A handler may return a promise to await. */
export interface ExtensionApi {
  on(event: LabelledEvent, handler: (event: SessionEvent, ctx: SessionContext | undefined) => Promise<void> | void): void;
}

/** Runs `hc` with these arguments and answers whether it succeeded. Never rejects. */
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
  return ctx?.hasUI === true && (ctx.mode === undefined || ctx.mode === "tui");
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
 * did. `env`, `run` and `shared` default to the process's own in production.
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
    if (next !== state.written && (await run(["label", terminal, `${SESSION_FILE_LABEL}=${next}`]))) {
      state.written = next;
    }
  };
  const sync = (value: string): Promise<void> => {
    state.wanted = value;
    state.queue = state.queue.then(write, write);
    return state.queue;
  };
  const update = (_event: SessionEvent, ctx: SessionContext | undefined): Promise<void> | undefined =>
    interactive(ctx) ? sync(sessionFileOf(ctx)) : undefined;
  pi.on("session_start", update);
  pi.on("agent_end", update);
  // Only a real quit clears the pane's label; `/new`, `/resume`, `/fork` and `/reload` hand over to the next runtime.
  pi.on("session_shutdown", (event, ctx) => (event.reason === "quit" && interactive(ctx) ? sync("") : undefined));
  return true;
}

/** `hc` on the PATH, or `COLLIE_HC_BIN`; 1.5 s at most. Never rejects. */
function runHc(args: readonly string[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  try {
    execFile(process.env.COLLIE_HC_BIN ?? "hc", [...args], { timeout: 1500 }, (error) => resolve(error === null));
  } catch {
    resolve(false);
  }
  return promise;
}

export default function collieSessionLabel(pi: ExtensionApi): void {
  activate(pi, process.env, runHc);
}
