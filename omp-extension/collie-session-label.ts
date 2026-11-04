import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

// An Oh My Pi extension that names the pane's session file on its herdr-core terminal (#675).
//
// herdr-core keeps a terminal's status but not its agent's conversation, so a pane whose folder holds
// a second pi or omp pane cannot be told apart by its folder (#508). Oh My Pi knows its session file;
// this extension writes it into a terminal label, `omp.session_file`, and removes the label when the
// session ends. The label is a best-effort lookup hint, never proof: the reader confines it to the
// harness's own log folder and checks it as it would any session ref (ADR 0024).
//
// When it writes:
//  - on the events after which Oh My Pi itself says the session file may have changed
//    (`session_start`, `session_switch`, `session_branch`: `/new`, `/resume`, a fork, a branch);
//  - at the end of every turn (`agent_end`), which catches a file that moved without an event
//    (`/move`) and retries a write that failed;
//  - on `session_shutdown`, to remove it.
// A value counts as written only once `hc` succeeded, so a failed write is tried again at the next
// event. Writes run one at a time and always write the newest value, so quick switches collapse into
// one write. Each handler returns its write, so Oh My Pi can wait for it; `hc` gets 1.5 s, inside the
// 2 s budget Oh My Pi gives a shutdown handler. A process killed outright leaves its last label behind.
//
// It does nothing outside herdr-core (no `HC_TERMINAL_ID`), in a nested omp (`OMPCODE=1`, set in the
// shells a parent session spawns) and in a session with no UI (a subagent, a print run).
//
// Install: copy this file into `~/.omp/agent/extensions/`, then start omp again.

/** The herdr-core terminal label whose value is the session's `.jsonl` path. */
export const SESSION_FILE_LABEL = "omp.session_file";

/** The part of a session's context this extension reads. */
export interface SessionContext {
  readonly hasUI?: boolean;
  readonly sessionManager?: { getSessionFile?(): string | undefined };
}

/** A session event's payload. Nothing in it is read: the context names the session. */
export interface SessionEvent {
  readonly reason?: string;
}

/** The Oh My Pi events this extension listens to. */
export type LabelledEvent = "session_start" | "session_switch" | "session_branch" | "agent_end" | "session_shutdown";

/** The part of Oh My Pi's extension API this extension uses. A handler may return a promise to await. */
export interface ExtensionApi {
  on(event: LabelledEvent, handler: (event: SessionEvent, ctx: SessionContext | undefined) => Promise<void> | void): void;
}

/** Runs `hc` with these arguments and answers whether it succeeded. Never rejects. */
export type HcRunner = (args: readonly string[]) => Promise<boolean>;

/** The session's file as an absolute path, or "" when it has none (an in-memory session). */
export function sessionFileOf(ctx: SessionContext | undefined): string {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return file !== undefined && isAbsolute(file) ? file : "";
  } catch {
    return "";
  }
}

/**
 * Hook the events when this omp is the root agent of a herdr-core terminal, and answer whether it
 * did. `env` and `run` are the process's own in production.
 */
export function activate(pi: ExtensionApi, env: Readonly<Record<string, string | undefined>>, run: HcRunner): boolean {
  const terminal = env.HC_TERMINAL_ID;
  if (terminal === undefined || terminal === "" || env.OMPCODE === "1") return false;
  // `wanted` is the newest value asked for, `written` the last one `hc` confirmed ("" = removed).
  let wanted = "";
  let written: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  // One write: the newest value, unless `hc` already holds it. A failure leaves `written` as it was.
  const write = async (): Promise<void> => {
    const next = wanted;
    if (next !== written && (await run(["label", terminal, `${SESSION_FILE_LABEL}=${next}`]))) written = next;
  };
  const sync = (value: string): Promise<void> => {
    wanted = value;
    queue = queue.then(write);
    return queue;
  };
  const update = (_event: SessionEvent, ctx: SessionContext | undefined): Promise<void> | undefined =>
    ctx?.hasUI === true ? sync(sessionFileOf(ctx)) : undefined;
  pi.on("session_start", update);
  pi.on("session_switch", update);
  pi.on("session_branch", update);
  pi.on("agent_end", update);
  pi.on("session_shutdown", (_event, ctx) => (ctx?.hasUI === true ? sync("") : undefined));
  return true;
}

/** `hc` on the PATH, or `COLLIE_HC_BIN`; 1.5 s at most. */
function runHc(args: readonly string[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile(process.env.COLLIE_HC_BIN ?? "hc", [...args], { timeout: 1500 }, (error) => resolve(error === null));
  return promise;
}

export default function collieSessionLabel(pi: ExtensionApi): void {
  activate(pi, process.env, runHc);
}
