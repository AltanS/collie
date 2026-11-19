// HOW THE REX ADAPTER TALKS TO REX — the subprocess seam.
//
// Rex is a server with a `rex` CLI client. This file is the single place that spawns it; the
// conformance fixture swaps {@link RexExec} for an in-memory one.
//
// SPAWN HYGIENE:
//  • No shell: arguments go to Bun.spawn as an array.
//  • A fixed binary probe: `PATH` is not read, because a background service does not share a login
//    shell's (`COLLIE_REX_BIN` names any other place).
//  • `--autostart=false` on every call. Rex's CLI starts a missing local server by default; Collie
//    mirrors the terminal the operator runs and never starts one of its own. Probed: with it, a
//    missing server answers exit 4, `no Rex server is running at …, and autostart is disabled`.
//  • `--color=never`, so an error sentence is plain text for the classifiers in protocol.ts.
//  • A hung child is killed on the target's budget: SIGTERM, then SIGKILL a moment later.
//  • Typed text rides STDIN (`printf … | rex send`, probed), not argv, so it has no kernel argv cap
//    and never shows in `ps`.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** What one finished `rex …` command said. */
export interface RexRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Long-lived event stream handlers. */
export interface RexStreamHandlers {
  onLine(line: string): void;
  onExit(reason: string): void;
}

/** The handle a stream hands back. `kill()` is idempotent. */
export interface RexStreamClient {
  kill(): void;
}

/** The surface the adapter needs from rex — narrow, so the fixture can stand in for it. */
export interface RexExec {
  run(args: readonly string[], stdin?: string): Promise<RexRunResult>;
  events(handlers: RexStreamHandlers): RexStreamClient;
}

/**
 * Where the `rex` binary is looked for, in order. Probed: the Linux package installs `/usr/bin/rex`
 * and exports `REX_BIN_DIR=/usr/bin` into every block; the others are the usual user, local and
 * Homebrew prefixes.
 */
export function rexBinaryCandidates(home: string = process.env.HOME ?? ""): readonly string[] {
  const local = home.length > 0 ? [`${home}/.local/bin/rex`] : [];
  return [...local, "/usr/local/bin/rex", "/usr/bin/rex", "/bin/rex", "/opt/homebrew/bin/rex", "/opt/local/bin/rex"];
}

/** The absolute path of the rex binary, or null when there is none. */
export function resolveRexBinary(
  configured: string,
  exists: (path: string) => boolean = existsSync,
  candidates: readonly string[] = rexBinaryCandidates(),
): string | null {
  const named = configured.trim();
  if (named.length > 0) return isAbsolute(named) && exists(named) ? named : null;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/**
 * The socket a Linux rex server listens on when nothing else is configured. Probed:
 * `unix:///run/user/1000/rex/server.sock`, the address `REX_SERVER` carries inside every block. Only
 * the CLI-probe in `cli/mux-list.ts` reads this; the adapter itself lets `rex` find its own server.
 */
export function defaultRexSocket(
  runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR,
  uid: number = process.getuid?.() ?? 1000,
): string {
  const dir = runtimeDir?.trim() ? runtimeDir.trim() : `/run/user/${String(uid)}`;
  return `${dir}/rex/server.sock`;
}

export const NO_REX_BINARY = "no rex binary found — set COLLIE_REX_BIN to its absolute path";
export const TIMED_OUT_CODE = 143;
/** The code {@link SpawnRexExec.run} answers with when there is no binary to run. */
export const NO_BINARY_CODE = 127;
/** How long a child gets between SIGTERM and SIGKILL when it overruns its budget. */
export const KILL_GRACE_MS = 1000;

export function timedOutMessage(args: readonly string[], timeoutMs: number): string {
  const verb = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ") || "the call";
  return `rex did not answer \`${verb}\` within ${String(timeoutMs)}ms and was killed`;
}

/**
 * The options every call carries ahead of its own: never autostart, no colour, and the server the
 * operator named, when they named one. `-S` takes a host label or a server address; empty lets rex
 * find its own, which is the default on every platform.
 */
export function globalArgs(endpoint: string): string[] {
  const args = ["--autostart=false", "--color=never"];
  const server = endpoint.trim();
  if (server !== "") args.push("-S", server);
  return args;
}

/** Real execution via Bun.spawn. */
export class SpawnRexExec implements RexExec {
  constructor(
    private readonly binary: string | null,
    private readonly endpoint: string,
    private readonly timeoutMs: number,
  ) {}

  async run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    if (this.binary === null) return { code: NO_BINARY_CODE, stdout: "", stderr: NO_REX_BINARY };
    const child = Bun.spawn([this.binary, ...globalArgs(this.endpoint), ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

    let killed = false;
    let hardKill: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      // A child that ignores SIGTERM would keep `stdout` open and this call pending forever.
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, this.timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const code = await child.exited;
      if (killed) return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, this.timeoutMs) };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (hardKill !== null) clearTimeout(hardKill);
    }
  }

  events(handlers: RexStreamHandlers): RexStreamClient {
    if (this.binary === null) {
      queueMicrotask(() => handlers.onExit(NO_REX_BINARY));
      return { kill: () => undefined };
    }
    // `--all` is the one stream that carries session creation, every session's structure AND every
    // block's custom events (program status, title, folder). Probed: without it a stream sees no
    // block events, and `-s` sees one session only. stderr is ignored, not piped: nothing reads it,
    // and an undrained pipe blocks the child once full.
    const child = Bun.spawn([this.binary, ...globalArgs(this.endpoint), "events", "--all", "--json"], {
      stdin: "ignore",
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
        end("the rex event stream ended");
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
