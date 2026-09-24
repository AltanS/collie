// `herdr terminal session control` AS A SIZE HOLD — the "Fit to phone" write (ADR 0049).
//
// One child process per hold. It is started with the size on its command line, and that is the whole
// write: the PTY takes the size while the controller is attached, and Herdr hands the desk's size
// back the moment it detaches (HERDR_API.md § `terminal session control`). So this module does three
// things and refuses to do a fourth:
//
//   • it starts the child against THIS adapter's socket (`HERDR_SOCKET_PATH`, the same endpoint the
//     socket client dials — never a session name, which the adapter does not have);
//   • it reads the FIRST line to learn whether the hold took, and classifies a refusal;
//   • it drains everything after that unread, so the pipe can never back up and stall Herdr, and
//     watches only for the child ending.
//
// It never parses a frame. The first line is read for its `type` and `reason`, nothing else; after
// that the bytes are counted as nothing. Reading frames would be the emulator ADR 0008 refuses, by
// another door. It never writes to the child's stdin either: closing it is the release.

import { decodeControlRecord } from "../../wire.ts";
import { muxGone, muxOk, muxRefused, muxUnreachable, type MuxOutcome, type MuxSize, type MuxSizeHold } from "../types.ts";

/** The binary. Resolved off PATH, as `machine-list.ts` resolves it. */
const HERDR = "herdr";

/** How long the first line may take before the attempt is abandoned. A hold that took answers at once. */
export const HOLD_START_TIMEOUT_MS = 5000;

/** How long a released child gets to detach on stdin EOF before it is killed. */
export const HOLD_RELEASE_GRACE_MS = 2000;

/** Herdr's refusal when another controller holds the terminal (probed 2026-09-24, herdr 0.9.1). */
const HELD_ELSEWHERE = "already has an attached client";

/** Herdr's refusal when the terminal does not exist in this session. */
const NOT_FOUND = "not found";

/**
 * The marker of the closing record. Safe to find by substring in a stream of frames because a frame's
 * payload is base64, which has no quote character to spell it with.
 */
const CLOSED_MARKER = '"terminal.closed"';

/** The child, as far as a hold needs it. `Bun.spawn`'s shape, narrowed so a test can fake it. */
export interface HoldProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Closing it is a clean detach: Herdr answers `terminal.closed` `detached` and the child exits. */
  endStdin(): void;
  kill(): void;
  readonly exited: Promise<number>;
}

/** Start the child. Throws when it cannot be started at all (no `herdr` on PATH). */
export type HoldSpawn = (argv: readonly string[], env: Readonly<Record<string, string>>) => HoldProcess;

/** What `HerdrMux.holdSize` delegates to, once it knows the pane's terminal. */
export type HerdrSizeHolder = (terminalId: string, size: MuxSize) => Promise<MuxOutcome<MuxSizeHold>>;

/** The holder a test-built adapter gets when it does not supply one: an honest refusal, never a hang. */
export const noSizeHolder: HerdrSizeHolder = () =>
  Promise.resolve(muxUnreachable("this adapter was built without a way to start `herdr terminal session control`"));

/** `Bun.spawn`, with stdin held open as the hold's lifeline and stderr kept for the refusal text. */
export const bunHoldSpawn: HoldSpawn = (argv, env) => {
  const proc = Bun.spawn([...argv], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    endStdin: () => {
      try {
        void proc.stdin.end();
      } catch {
        // Already closed: the child has gone, which is the state release wants.
      }
    },
    kill: () => proc.kill(),
    exited: proc.exited,
  };
};

/** The command line of one hold. Exported for the test that pins it against the probe. */
export function holdArgv(terminalId: string, size: MuxSize): string[] {
  return [
    HERDR,
    "terminal",
    "session",
    "control",
    terminalId,
    "--cols",
    String(size.cols),
    "--rows",
    String(size.rows),
  ];
}

/** Classify the closing record Herdr sent instead of a first frame. */
export function refusalOf(reason: string): MuxOutcome<never> {
  if (reason.includes(HELD_ELSEWHERE)) return muxRefused(reason);
  if (reason.includes(NOT_FOUND)) return muxGone(reason);
  return muxUnreachable(reason);
}

/** Up to `limit` bytes of a stream, as text, for a refusal's detail. Never throws. */
async function readSome(stream: ReadableStream<Uint8Array>, limit = 1024): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= limit) break;
    }
  } catch {
    // A stream torn down under us has said all it will.
  }
  return text.slice(0, limit).trim();
}

/**
 * The real holder for one Herdr socket.
 *
 * `spawn` and the timings are injected so the whole state machine is testable without a Herdr; the
 * factory passes {@link bunHoldSpawn}.
 */
export function herdrSizeHolder(
  socketPath: string,
  spawn: HoldSpawn = bunHoldSpawn,
  timing: { startMs: number; graceMs: number } = { startMs: HOLD_START_TIMEOUT_MS, graceMs: HOLD_RELEASE_GRACE_MS },
): HerdrSizeHolder {
  return async (terminalId, size) => {
    let proc: HoldProcess;
    try {
      proc = spawn(holdArgv(terminalId, size), { HERDR_SOCKET_PATH: socketPath });
    } catch (err) {
      return muxUnreachable(`could not start \`herdr\`: ${err instanceof Error ? err.message : String(err)}`);
    }
    return startHold(proc, timing);
  };
}

/** Read the first line, decide, then drain. Exported for the tests. */
export async function startHold(
  proc: HoldProcess,
  timing: { startMs: number; graceMs: number },
): Promise<MuxOutcome<MuxSizeHold>> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The first line, or null when the child ended (or timed out) before sending one.
  const firstLine = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => resolve(null), timing.startMs);
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return resolve(null);
          buffered += decoder.decode(value, { stream: true });
          const newline = buffered.indexOf("\n");
          if (newline >= 0) return resolve(buffered.slice(0, newline));
        }
      } catch {
        resolve(null);
      }
    })();
  });

  const line = await firstLine;
  clearTimeout(timer);
  const record = line === null ? null : decodeControlRecord(line);

  if (record?.type !== "terminal.frame") {
    proc.kill();
    void reader.cancel().catch(() => undefined);
    if (record?.type === "terminal.closed") return refusalOf(record.reason);
    const stderr = await readSome(proc.stderr);
    const why = line === null ? "`herdr terminal session control` sent nothing" : "an unexpected first record";
    return muxUnreachable(stderr.length > 0 ? `${why}: ${stderr}` : why);
  }

  // Held. From here the child's output is drained and never read, except for the closing marker,
  // which ends a hold that was taken from us rather than waiting on the child to exit.
  let carry = buffered.slice(buffered.indexOf("\n") + 1).slice(-CLOSED_MARKER.length);
  let closedSeen = false;
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = carry + decoder.decode(value, { stream: true });
        if (!closedSeen && text.includes(CLOSED_MARKER)) {
          closedSeen = true;
          proc.kill();
        }
        carry = text.slice(-CLOSED_MARKER.length);
      }
    } catch {
      // The child is gone; `exited` reports it.
    }
  })();
  // stderr is not read while held, so it must be drained too or a chatty child could stall on it.
  void readSome(proc.stderr, Number.POSITIVE_INFINITY);

  let released = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const ended = proc.exited.then(
    (code) => {
      clearTimeout(killTimer);
      if (released) return "released";
      if (closedSeen) return "Herdr closed the hold (another controller took the terminal, or it went away)";
      return `the hold ended on its own (exit ${code})`;
    },
    () => "the hold ended",
  );

  return muxOk<MuxSizeHold>({
    release() {
      if (released) return;
      released = true;
      proc.endStdin();
      killTimer = setTimeout(() => proc.kill(), timing.graceMs);
    },
    ended,
  });
}
