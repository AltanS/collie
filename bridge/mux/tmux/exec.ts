// HOW THE TMUX ADAPTER TALKS TO TMUX — one narrow seam, and the only file that spawns a process.
//
// tmux has no socket protocol a client can speak; the client IS the `tmux` binary. So this adapter's
// "transport" is a subprocess, and it is behind an interface for exactly the reason `HerdrRpc` is:
// the conformance fixture (fixture.ts) implements {@link TmuxExec} over an in-memory world, which is
// what lets the pure layer prove the WHOLE adapter — every argv it builds, every stderr it reads —
// on a box with no tmux installed (MUX_CONTRIBUTING.md § The two layers).
//
// SPAWN HYGIENE, ADR 0015's pattern book, applied one for one:
//
//  • **No shell, ever.** Every call is an argv array through `Bun.spawn`, so a pane title, a label or
//    a message the operator typed is a single argument and never a fragment of a command line. There
//    is no interpolation anywhere in this adapter.
//  • **No PATH assumption.** The binary is resolved ONCE, from an explicit setting or by probing
//    fixed paths (`[ -x ]`, in ADR 0015's words). A Herdr plugin action gets no login shell, so a
//    bare `tmux` would resolve differently under systemd than in the operator's terminal — memory
//    `collie-herdr-action-env` is that trap, already paid for once.
//  • **Secrets and long payloads ride stdin.** Literal text is written to a tmux paste buffer over
//    stdin rather than passed as an argument: it dodges `MAX_ARG_STRLEN` (128 KiB per argv element on
//    Linux — a long reply would simply fail) and it dodges tmux's own argument lexer, which eats a
//    trailing `;` as a command separator (probed, M10/04).
//
// HOST-LOCAL BY RULE. Nothing here takes a host and nothing here may grow one: `-L`/`-S` name a
// socket on THIS machine's filesystem. A remote tmux is reached by talking to the Collie running on
// that machine (ADR 0011), never by teaching this file to reach across one.

import { existsSync } from "node:fs";

/** What one finished `tmux …` invocation said. `code` is 0 on success, non-zero on refusal. */
export interface TmuxRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a long-lived control-mode client reports back. */
export interface TmuxControlHandlers {
  /** One line of control-mode output, newline already stripped. */
  onLine(line: string): void;
  /** The client ended, for any reason, at most once per client. */
  onExit(reason: string): void;
}

/** The handle a control-mode client hands back. `kill()` is idempotent. */
export interface TmuxControlClient {
  kill(): void;
}

/**
 * The whole surface the adapter needs from tmux, and the seam the conformance fixture replaces.
 *
 * Deliberately two methods: everything tmux answers is either a one-shot command or the one
 * long-lived control-mode stream. `args` never includes the binary or the server flags — the exec
 * prepends those (see {@link tmuxServerArgs}), so a caller composes only the tmux command it means.
 */
export interface TmuxExec {
  /** Run one tmux command to completion, optionally feeding it `stdin`. */
  run(args: readonly string[], stdin?: string): Promise<TmuxRunResult>;
  /** Start a control-mode client. It is the caller's to `kill()`. */
  control(args: readonly string[], handlers: TmuxControlHandlers): TmuxControlClient;
}

/**
 * Where tmux is, in probe order, when the operator names no binary.
 *
 * Fixed absolute paths rather than a `PATH` walk, for the reason in the header: this process may be
 * started by systemd or by a Herdr plugin action, neither of which has the operator's `PATH`. The
 * order is distro default, then `/bin` (merged-usr systems answer both), then the two package
 * managers that install outside it — Homebrew on Apple silicon and MacPorts.
 */
export const TMUX_BINARY_CANDIDATES: readonly string[] = [
  "/usr/bin/tmux",
  "/bin/tmux",
  "/usr/local/bin/tmux",
  "/opt/homebrew/bin/tmux",
  "/opt/local/bin/tmux",
];

/**
 * The tmux binary this adapter will run, or `null` when there is none to run.
 *
 * `configured` wins and is required to be ABSOLUTE — a relative binary name would be resolved
 * against a `PATH` this process does not control, which is the one thing the fixed-path probe exists
 * to avoid. `null` is not an error here: it becomes `reachable() === false`, which is how an
 * operator who set `COLLIE_MUX=tmux` on a box without tmux learns what happened.
 */
export function resolveTmuxBinary(
  configured: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const named = configured.trim();
  if (named.length > 0) return named.startsWith("/") && exists(named) ? named : null;
  return TMUX_BINARY_CANDIDATES.find((candidate) => exists(candidate)) ?? null;
}

/**
 * Which tmux SERVER to talk to, as tmux itself addresses one.
 *
 * tmux has no notion of connecting to a host — a server is a unix socket under the user's runtime
 * dir, named (`-L name`) or given by path (`-S path`). Collie's configured endpoint is one string
 * and the fork is the only ambiguity: a value carrying a `/` is a path, anything else is a name, and
 * an empty value means tmux's own default server. That rule is the documented default and it is
 * mechanical, so an operator can predict it without reading this file.
 */
export function tmuxServerArgs(endpoint: string): string[] {
  const target = endpoint.trim();
  if (target.length === 0) return [];
  return target.includes("/") ? ["-S", target] : ["-L", target];
}

/**
 * How tmux itself would name the server an endpoint addresses — the {@link tmuxServerArgs} fork in
 * words, for a log line or a `collie doctor` finding.
 *
 * Beside the fork rather than at either caller, so the startup line and the doctor finding cannot
 * come to disagree about what an endpoint means.
 */
export function tmuxServerLabel(endpoint: string): string {
  const args = tmuxServerArgs(endpoint);
  if (args.length === 0) return "tmux's own default server";
  return args[0] === "-S" ? `socket ${args[1] ?? ""}` : `socket name ${args[1] ?? ""}`;
}

/** The message a run reports when there is no tmux binary to run at all. */
export const NO_TMUX_BINARY = "no tmux binary found — set COLLIE_TMUX_BIN to its absolute path";

/**
 * The real exec: `Bun.spawn` with an argv array, a resolved binary and the server flags prepended.
 *
 * Not unit-tested and it must not need to be — CLAUDE.md § Tests: anything that needs `Bun.spawn`
 * cannot run under the pure layer. Everything above it is testable precisely because this class is
 * one indirection thick; the fixture swaps it out and the adapter never notices.
 */
export class SpawnTmuxExec implements TmuxExec {
  constructor(
    private readonly binary: string | null,
    private readonly serverArgs: readonly string[],
    private readonly timeoutMs: number,
  ) {}

  async run(args: readonly string[], stdin?: string): Promise<TmuxRunResult> {
    if (this.binary === null) return { code: 127, stdout: "", stderr: NO_TMUX_BINARY };
    const child = Bun.spawn([this.binary, ...this.serverArgs, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    // A hung tmux (a server mid-restart, a full socket) must not hold a request open forever: the
    // budget is the target's, and a kill turns it into the `unreachable` the banner already knows.
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

  control(args: readonly string[], handlers: TmuxControlHandlers): TmuxControlClient {
    if (this.binary === null) {
      queueMicrotask(() => handlers.onExit(NO_TMUX_BINARY));
      return { kill: () => undefined };
    }
    // stdin stays an open pipe and is never written: a control client reads commands from stdin and
    // exits the moment it closes, so holding it open IS what keeps the stream alive (probed, M10/04).
    const child = Bun.spawn([this.binary, ...this.serverArgs, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      handlers.onExit(reason);
    };
    void (async () => {
      try {
        await pumpLines(child.stdout, handlers.onLine);
        end("the control-mode client ended");
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
