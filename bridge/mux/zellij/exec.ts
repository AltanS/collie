// HOW THE ZELLIJ ADAPTER TALKS TO ZELLIJ — one narrow seam, and the only file that spawns a process.
//
// zellij's client is the `zellij` binary, exactly as tmux's is `tmux`, so this adapter's "transport"
// is a subprocess behind an interface — the same shape `bridge/mux/tmux/exec.ts` has and for the same
// reason: the conformance fixture (fixture.ts) implements {@link ZellijExec} over an in-memory world,
// which is what lets the pure layer prove the WHOLE adapter — every argv it builds, every line it
// parses — on a box with no zellij installed (MUX_CONTRIBUTING.md § The two layers).
//
// TWO METHODS, BECAUSE ZELLIJ ANSWERS IN EXACTLY TWO WAYS. {@link run} is a one-shot
// `zellij … action …` that prints and exits; {@link stream} is the one long-lived verb,
// `zellij … subscribe`, which pushes newline-delimited JSON until it is killed (probed, M10/05).
//
// SPAWN HYGIENE, ADR 0015's pattern book, applied one for one:
//
//  • **No shell, ever.** Every call is an argv array through `Bun.spawn`, so a label, a pane name or
//    a message the operator typed is a single argument and never a fragment of a command line.
//  • **No PATH assumption.** The binary is resolved ONCE, from an explicit setting or by probing
//    fixed paths. A Herdr plugin action gets no login shell, so a bare `zellij` would resolve
//    differently under systemd than in the operator's terminal — memory `collie-herdr-action-env`
//    is that trap, already paid for once. zellij's own installer puts it in `~/.local/bin`, which is
//    why that path is first in the candidate list rather than a distro prefix.
//  • **The environment is inherited, and one variable in it is load-bearing.** zellij finds its
//    running sessions through a socket directory under `XDG_RUNTIME_DIR`. Probed on zellij 0.44.2:
//    the same `list-sessions` run under `env -i` reported a LIVE session as `(EXITED …)`, and
//    reported it correctly again the moment `XDG_RUNTIME_DIR` was put back. `Bun.spawn` passes this
//    process's environment through by default, so nothing here strips it — but an operator whose
//    collie sees every session as exited is looking at a unit file with no `XDG_RUNTIME_DIR`.
//
// HOST-LOCAL BY RULE. Nothing here takes a machine address and nothing here may grow one: the
// endpoint is a session name on THIS box. Another machine is reached by talking to the Collie running
// on it (ADR 0011), never by teaching this file to reach across one.

import { existsSync } from "node:fs";

/** What one finished `zellij …` invocation said. `code` is 0 on success, non-zero on refusal. */
export interface ZellijRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the long-lived pane stream reports back. */
export interface ZellijStreamHandlers {
  /** One line of the stream's output, newline already stripped. */
  onLine(line: string): void;
  /** The stream ended, for any reason, at most once per client. */
  onExit(reason: string): void;
}

/** The handle a stream hands back. `kill()` is idempotent. */
export interface ZellijStreamClient {
  kill(): void;
}

/**
 * The whole surface the adapter needs from zellij, and the seam the conformance fixture replaces.
 *
 * `args` is the COMPLETE argument list after the binary, session flag included — unlike the tmux
 * seam, which prepends its server flags here. zellij's session is chosen per call and may have to be
 * discovered first (protocol.ts `chooseSession`), so the adapter owns that decision and this file
 * stays a pure "run the binary with these arguments".
 */
export interface ZellijExec {
  /** Run one zellij command to completion. */
  run(args: readonly string[]): Promise<ZellijRunResult>;
  /** Start the long-lived pane stream. It is the caller's to `kill()`. */
  stream(args: readonly string[], handlers: ZellijStreamHandlers): ZellijStreamClient;
}

/**
 * Where zellij is, in probe order, when the operator names no binary.
 *
 * Fixed absolute paths rather than a `PATH` walk, for the reason in the header. The order is the
 * one zellij's own install script uses first (`~/.local/bin`, and it is where the probe found 0.44.2
 * on the developer host), then the distro prefixes, then the two package managers that install
 * outside them — Homebrew on Apple silicon and MacPorts. `~` is expanded from `HOME` because a
 * literal tilde is a directory name to `existsSync`, not the operator's home.
 */
export function zellijBinaryCandidates(home: string = process.env.HOME ?? ""): readonly string[] {
  const local = home.length > 0 ? [`${home}/.local/bin/zellij`] : [];
  return [...local, "/usr/bin/zellij", "/bin/zellij", "/usr/local/bin/zellij", "/opt/homebrew/bin/zellij", "/opt/local/bin/zellij"];
}

/**
 * The zellij binary this adapter will run, or `null` when there is none to run.
 *
 * `configured` wins and is required to be ABSOLUTE — a relative binary name would be resolved
 * against a `PATH` this process does not control, which is the one thing the fixed-path probe exists
 * to avoid. `null` is not an error here: it becomes `reachable() === false`, which is how an operator
 * who set `COLLIE_MUX=zellij` on a box without zellij learns what happened.
 */
export function resolveZellijBinary(
  configured: string,
  exists: (path: string) => boolean = existsSync,
  candidates: readonly string[] = zellijBinaryCandidates(),
): string | null {
  const named = configured.trim();
  if (named.length > 0) return named.startsWith("/") && exists(named) ? named : null;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The message a run reports when there is no zellij binary to run at all. */
export const NO_ZELLIJ_BINARY = "no zellij binary found — set COLLIE_ZELLIJ_BIN to its absolute path";

/**
 * The real exec: `Bun.spawn` with an argv array and a resolved binary.
 *
 * Not unit-tested and it must not need to be — CLAUDE.md § Tests: anything that needs `Bun.spawn`
 * cannot run under the pure layer. Everything above it is testable precisely because this class is
 * one indirection thick; the fixture swaps it out and the adapter never notices.
 */
export class SpawnZellijExec implements ZellijExec {
  constructor(
    private readonly binary: string | null,
    private readonly timeoutMs: number,
  ) {}

  async run(args: readonly string[]): Promise<ZellijRunResult> {
    if (this.binary === null) return { code: 127, stdout: "", stderr: NO_ZELLIJ_BINARY };
    const child = Bun.spawn([this.binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // A zellij mid-restart must not hold a request open forever: the budget is the target's, and a
    // kill turns it into the `unreachable` the connected/disconnected banner already knows.
    const timer = setTimeout(() => child.kill(), this.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code: await child.exited, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  stream(args: readonly string[], handlers: ZellijStreamHandlers): ZellijStreamClient {
    if (this.binary === null) {
      queueMicrotask(() => handlers.onExit(NO_ZELLIJ_BINARY));
      return { kill: () => undefined };
    }
    // No timeout here, deliberately: this child is SUPPOSED to outlive every request. It ends when
    // the watch kills it, when every pane it follows has closed, or when zellij itself goes away —
    // and each of those arrives as `onExit`, which watch.ts turns into a re-establish or a re-census.
    const child = Bun.spawn([this.binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      handlers.onExit(reason);
    };
    void (async () => {
      try {
        await pumpLines(child.stdout, handlers.onLine);
        end("the pane stream ended");
      } catch (err) {
        end(err instanceof Error ? err.message : String(err));
      }
    })();
    return {
      kill: () => {
        child.kill();
        end("closed");
      },
    };
  }
}

/** Feed `onLine` one complete line at a time; resolves when the stream ends. */
async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let cut = buffered.indexOf("\n");
    while (cut >= 0) {
      onLine(buffered.slice(0, cut).replace(/\r$/u, ""));
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
    }
  }
  if (buffered.length > 0) onLine(buffered);
}
