// HOW THE TERN ADAPTER TALKS TO TERN — the subprocess seam.
//
// Tern provides a CLI `tern` and a session daemon connected via Unix domain socket.
// This file is the single place that spawns subprocesses for Tern.
// The conformance fixture swaps out `TernExec` with an in-memory implementation.
//
// SPAWN HYGIENE:
//  • No shell interpolation: arguments passed as arrays to Bun.spawn.
//  • Fixed binary path probe: does not assume PATH.
//  • Safe stdin handling for text payloads.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** What one finished `tern ...` command said. */
export interface TernRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Long-lived event stream handlers. */
export interface TernStreamHandlers {
  onLine(line: string): void;
  onExit(reason: string): void;
}

/** The handle a stream hands back. kill() is idempotent. */
export interface TernStreamClient {
  kill(): void;
}

/** Surface required from Tern by the adapter. */
export interface TernExec {
  run(args: readonly string[], stdin?: string): Promise<TernRunResult>;
  events(handlers: TernStreamHandlers): TernStreamClient;
}

/** Default binary candidates in probe order. */
export function ternBinaryCandidates(home: string = process.env.HOME ?? ""): readonly string[] {
  const local = home.length > 0 ? [`${home}/.local/opt/tern/tern`, `${home}/.local/bin/tern`] : [];
  return [
    ...local,
    "/usr/bin/tern",
    "/bin/tern",
    "/usr/local/bin/tern",
    "/opt/homebrew/bin/tern",
    "/opt/local/bin/tern",
  ];
}

/** Resolves an absolute path to the tern binary, or null when absent. */
export function resolveTernBinary(
  configured: string,
  exists: (path: string) => boolean = existsSync,
  candidates: readonly string[] = ternBinaryCandidates(),
): string | null {
  const named = configured.trim();
  if (named.length > 0) return isAbsolute(named) && exists(named) ? named : null;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Default socket location for Tern daemon. */
export function defaultTernSocket(
  runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR,
  uid: number = process.getuid?.() ?? 1000,
): string {
  if (runtimeDir && runtimeDir.trim() !== "") {
    return `${runtimeDir.trim()}/tern/daemon.sock`;
  }
  return `/tmp/tern-${String(uid)}/daemon.sock`;
}

export const NO_TERN_BINARY = "no tern binary found — set COLLIE_TERN_BIN to its absolute path";
export const TIMED_OUT_CODE = 143;

export function timedOutMessage(args: readonly string[], timeoutMs: number): string {
  const verb = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ") || "the call";
  return `tern did not answer \`${verb}\` within ${String(timeoutMs)}ms and was killed`;
}

/** Real execution via Bun.spawn. */
export class SpawnTernExec implements TernExec {
  constructor(
    private readonly binary: string | null,
    private readonly socketPath: string,
    private readonly timeoutMs: number,
  ) {}

  async run(args: readonly string[], stdin?: string): Promise<TernRunResult> {
    if (this.binary === null) return { code: 127, stdout: "", stderr: NO_TERN_BINARY };
    const env = { ...process.env };
    if (this.socketPath) env.TERN_DAEMON_SOCKET = this.socketPath;

    const child = Bun.spawn([this.binary, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, this.timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      if (killed) return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, this.timeoutMs) };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  events(handlers: TernStreamHandlers): TernStreamClient {
    if (this.binary === null) {
      queueMicrotask(() => handlers.onExit(NO_TERN_BINARY));
      return { kill: () => undefined };
    }
    const env = { ...process.env };
    if (this.socketPath) env.TERN_DAEMON_SOCKET = this.socketPath;

    const child = Bun.spawn([this.binary, "events"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
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
        end("the tern event stream ended");
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
