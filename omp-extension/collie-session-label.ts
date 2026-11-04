import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

// An Oh My Pi extension that names the pane's live session on its herdr-core terminal (#675).
//
// herdr-core keeps a terminal's status but not its agent's conversation, so a pane whose folder holds
// a second pi or omp pane cannot be told apart by its folder (#508). Oh My Pi knows its session file;
// this extension writes it into a terminal label, `omp.session_file`, on every session start and
// switch (`/new`, `/resume`, a fork), and removes the label when the session ends, so a shell left
// behind never carries it. The label is a lookup hint only: the reader confines it to the harness's
// own log folder (ADR 0024).
//
// It does nothing outside herdr-core (no `HC_TERMINAL_ID`), in a nested omp (`OMPCODE=1`, set in the
// shells a parent session spawns) and in a session with no UI (a subagent, a print run). It writes
// through the `hc` command line, once per change and in order; a failed `hc` is dropped, since the
// next session change writes the label again.
//
// Install: copy this file into `~/.omp/agent/extensions/`. A running omp picks it up on its next
// start or `/reload`.

/** The herdr-core terminal label whose value is the live session's `.jsonl` path. */
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

/** The part of Oh My Pi's extension API this extension uses. */
export interface ExtensionApi {
  on(
    event: "session_start" | "session_switch" | "session_shutdown",
    handler: (event: SessionEvent, ctx: SessionContext | undefined) => void,
  ): void;
}

/** Runs `hc` with these arguments and resolves once it has ended, whatever the outcome. */
export type HcRunner = (args: readonly string[]) => Promise<void>;

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
 * Hook the session events when this omp is the root agent of a herdr-core terminal, and answer
 * whether it did. `env` and `run` are the process's own in production.
 */
export function activate(pi: ExtensionApi, env: Readonly<Record<string, string | undefined>>, run: HcRunner): boolean {
  const terminal = env.HC_TERMINAL_ID;
  if (terminal === undefined || terminal === "" || env.OMPCODE === "1") return false;
  // The value last asked for: a path, or "" once removed. One `hc` per change, run in order.
  let written: string | undefined;
  let queue = Promise.resolve();
  const label = (value: string): void => {
    if (value === written) return;
    written = value;
    queue = queue.then(() => run(["label", terminal, `${SESSION_FILE_LABEL}=${value}`]));
  };
  const update = (_event: SessionEvent, ctx: SessionContext | undefined): void => {
    if (ctx?.hasUI === true) label(sessionFileOf(ctx));
  };
  pi.on("session_start", update);
  pi.on("session_switch", update);
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.hasUI === true) label("");
  });
  return true;
}

/** `hc` on the PATH, or `COLLIE_HC_BIN`; three seconds at most, its outcome ignored. */
function runHc(args: readonly string[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  execFile(process.env.COLLIE_HC_BIN ?? "hc", [...args], { timeout: 3000 }, () => resolve());
  return promise;
}

export default function collieSessionLabel(pi: ExtensionApi): void {
  activate(pi, process.env, runHc);
}
