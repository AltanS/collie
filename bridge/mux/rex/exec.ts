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
//    mirrors the terminal the operator runs and never asks for one of its own. Probed: with it, a
//    missing server answers exit 4, `no Rex server is running at …, and autostart is disabled`.
//    The flag cannot stop systemd: where `rex.socket` listens (what `rex server install` enables on
//    Linux), the connection itself starts the server, and the 5 s census then keeps it from idling
//    out (probed, API revision 19). docs/multiplexers.md says so to the operator.
//  • `--color=never`, so an error sentence is plain text for the classifiers in protocol.ts.
//  • A hung child is killed on the target's budget: SIGTERM, then SIGKILL a moment later.
//  • Typed text rides STDIN (`printf … | rex send`, probed), not argv, so it has no kernel argv cap
//    and never shows in `ps`.
//  • `REX_SESSION` and `REX_BLOCK` are stripped from the child (`rexChildEnv`): an ambient session
//    scopes every bare `-b`, so a bridge started inside one Rex session would lose sight of the
//    server's others (probed, API revision 11).

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { HOST } from "../../host.ts";

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
 * and exports `REX_BIN_DIR=/usr/bin` into every block, and the macOS app does the same for the copy
 * inside its bundle (`REX_BIN_DIR=…/Rex Server.app/Contents/MacOS`), which on a Mac is the only place
 * one lives — no prefix in the fixed list below holds it. `REX_BIN_DIR` is read first for that reason;
 * the others are the usual user, local and Homebrew prefixes.
 */
export function rexBinaryCandidates(
  home: string = process.env.HOME ?? "",
  binDir: string = process.env.REX_BIN_DIR ?? "",
): readonly string[] {
  // Only an absolute folder counts: a relative one would resolve against the bridge's own working
  // directory, which is not where any Rex install put its binary.
  const dir = binDir.trim();
  const own = dir !== "" && isAbsolute(dir) ? [`${dir}/rex`] : [];
  const local = home.length > 0 ? [`${home}/.local/bin/rex`] : [];
  return [...own, ...local, "/usr/local/bin/rex", "/usr/bin/rex", "/bin/rex", "/opt/homebrew/bin/rex", "/opt/local/bin/rex"];
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
 * The socket a rex server listens on when nothing else is configured. Probed on Linux:
 * `unix:///run/user/1000/rex/server.sock`, the address `REX_SERVER` carries inside every block. On
 * macOS (API revision 11) a server honours `XDG_RUNTIME_DIR` when one is set — `mux-e2e` starts its
 * throwaway that way — and the app-managed default, with none set, is
 * `~/Library/Application Support/rex/server.sock`. Only the CLI-probe in `cli/mux-list.ts` reads
 * this; the adapter itself lets `rex` find its own server.
 */
export function defaultRexSocket(
  // No default: an explicit `undefined` is "no runtime dir in this environment", and a default would
  // replace it with the bridge's own, so a caller's seam (cli/mux-list.ts passes ctx.env's) would leak.
  runtimeDir: string | undefined,
  uid: number = process.getuid?.() ?? 1000,
  home: string = process.env.HOME ?? "",
  platform: NodeJS.Platform = HOST.platform,
): string {
  const dir = runtimeDir?.trim();
  if (dir) return `${dir}/rex/server.sock`;
  if (platform === "darwin") return `${home}/Library/Application Support/rex/server.sock`;
  return `/run/user/${String(uid)}/rex/server.sock`;
}

/**
 * Why there is no rex to run, in words an operator can act on: the value of `COLLIE_REX_BIN` when it
 * names one that is not there, else every path that was tried. A Herdr plugin action gets no login
 * shell, so `PATH` is never part of the search, and the sentence says where the search did look.
 */
export function noRexBinaryMessage(configured: string, candidates: readonly string[]): string {
  const named = configured.trim();
  if (named !== "") return `COLLIE_REX_BIN="${named}" is not an absolute path to a file that is there`;
  return `no rex binary at ${candidates.join(", ")}; set COLLIE_REX_BIN to its absolute path`;
}
export const TIMED_OUT_CODE = 143;
/**
 * Why an endpoint cannot be used, or null when it can. One that starts with a dash is never a host
 * label or a server address. Probed on API revision 19: `rex -S --help` takes `--help` as the server
 * and then dials `https://--help` over the network, so such an endpoint is refused before any call.
 */
export function badRexEndpoint(endpoint: string): string | null {
  const server = endpoint.trim();
  if (!server.startsWith("-")) return null;
  return `the Rex endpoint "${server}" starts with a dash, so it is not a host label or a server address`;
}

/** The code {@link SpawnRexExec.run} answers with when there is no binary to run, or no usable endpoint. */
export const NO_BINARY_CODE = 127;
/** How long a child gets between SIGTERM and SIGKILL when it overruns its budget. */
export const KILL_GRACE_MS = 1000;

/**
 * How much one `rex capture` may print, stdout and stderr together, before it is killed. Rex keeps
 * about 64 MiB of scrollback per terminal, and the whole VT capture of a full ring measured 7.1 MB
 * (96,000 styled rows, API revision 19), so 64 MiB is nine times that and still a bound.
 */
export const CAPTURE_OUTPUT_CAP = 64 * 1024 * 1024;
/**
 * How much any other call may print. The largest honest answer is a `blob_read` of up to 960 KiB of
 * JSON string plus its envelope; every listing and status is a few kB.
 */
export const CALL_OUTPUT_CAP = 2 * 1024 * 1024;
/** One line of the `rex events` stream. An event is a few hundred bytes; a longer line is dropped. */
export const EVENT_LINE_CAP = 1024 * 1024;
/** The code {@link SpawnRexExec.run} answers with when a child printed past its cap. Not a rex code. */
export const OUTPUT_CAPPED_CODE = 190;

/** The output cap of one call: the whole capture is the one call that may be large. */
export function outputCapFor(args: readonly string[]): number {
  return args[0] === "capture" ? CAPTURE_OUTPUT_CAP : CALL_OUTPUT_CAP;
}

export function cappedMessage(args: readonly string[], cap: number): string {
  const verb = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ") || "the call";
  return `rex printed more than ${String(cap)} bytes for \`${verb}\` and was killed`;
}

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

/**
 * The environment every child runs with: the operator's, minus rex's own scope markers. Probed on API
 * revision 11 (macOS): a bare `-b <id>` resolves within `-s` or the ambient `REX_SESSION` only —
 * pointed at a session that does not hold the block, it answers exit 3, `block target "…" not
 * found` — while with no ambient scope the id resolves across the whole server, which is what an
 * adapter that addresses panes by bare id needs. `REX_BLOCK` goes with it. `REX_SERVER` stays: it
 * names the server an empty endpoint means, the one the operator's own block belongs to.
 */
export function rexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.REX_SESSION;
  delete child.REX_BLOCK;
  return child;
}

/** Real execution via Bun.spawn. */
export class SpawnRexExec implements RexExec {
  constructor(
    private readonly binary: string | null,
    private readonly endpoint: string,
    private readonly timeoutMs: number,
    /** What a call answers when {@link binary} is null; see {@link noRexBinaryMessage}. */
    private readonly noBinary: string = noRexBinaryMessage("", rexBinaryCandidates()),
  ) {}

  async run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    if (this.binary === null) return { code: NO_BINARY_CODE, stdout: "", stderr: this.noBinary };
    const badEndpoint = badRexEndpoint(this.endpoint);
    if (badEndpoint !== null) return { code: NO_BINARY_CODE, stdout: "", stderr: badEndpoint };
    const child = Bun.spawn([this.binary, ...globalArgs(this.endpoint), ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: rexChildEnv(),
    });

    let killed = false;
    let hardKill: ReturnType<typeof setTimeout> | null = null;
    const stop = (): void => {
      if (hardKill !== null) return;
      child.kill();
      // A child that ignores SIGTERM would keep `stdout` open and this call pending forever.
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      killed = true;
      stop();
    }, this.timeoutMs);

    // stdout and stderr count against one cap as they arrive; past it the child is stopped and what
    // it printed is dropped, so a runaway answer never reaches the bridge's memory whole.
    const cap = outputCapFor(args);
    const counter = { bytes: 0, over: false };
    const onBytes = (size: number): boolean => {
      counter.bytes += size;
      if (counter.bytes <= cap) return true;
      if (!counter.over) {
        counter.over = true;
        stop();
      }
      return false;
    };

    try {
      const [stdout, stderr] = await Promise.all([readCapped(child.stdout, onBytes), readCapped(child.stderr, onBytes)]);
      const code = await child.exited;
      if (counter.over) return { code: OUTPUT_CAPPED_CODE, stdout: "", stderr: cappedMessage(args, cap) };
      if (killed) return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, this.timeoutMs) };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (hardKill !== null) clearTimeout(hardKill);
    }
  }

  events(handlers: RexStreamHandlers): RexStreamClient {
    if (this.binary === null) {
      const why = this.noBinary;
      queueMicrotask(() => handlers.onExit(why));
      return { kill: () => undefined };
    }
    const badEndpoint = badRexEndpoint(this.endpoint);
    if (badEndpoint !== null) {
      queueMicrotask(() => handlers.onExit(badEndpoint));
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
      env: rexChildEnv(),
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

/** A stream's text, read while `onBytes` allows; once it says no, the rest is drained and dropped. */
async function readCapped(stream: ReadableStream<Uint8Array>, onBytes: (size: number) => boolean): Promise<string> {
  const chunks: Uint8Array[] = [];
  let keep = true;
  for await (const chunk of stream) {
    if (keep && onBytes(chunk.byteLength)) chunks.push(chunk);
    else keep = false;
  }
  if (!keep) return "";
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Splits a stream into lines. A line longer than `cap` characters is dropped whole: its start is
 * thrown away once it passes the cap, and the rest is skipped up to its newline, so an unterminated
 * line cannot grow the buffer without limit.
 */
export async function pumpLines(stream: AsyncIterable<Uint8Array>, onLine: (line: string) => void, cap: number = EVENT_LINE_CAP): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  let skipping = false;
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let cut = buffered.indexOf("\n");
    while (cut >= 0) {
      if (!skipping) onLine(buffered.slice(0, cut).replace(/\r$/u, ""));
      skipping = false;
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
    }
    if (buffered.length > cap) {
      buffered = "";
      skipping = true;
    }
  }
  if (buffered.length > 0 && !skipping) onLine(buffered);
}
