import { accessSync, constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandLookup, type LocalCliSttSettings } from "./config.ts";
import {
  createSttDeadline,
  SttCancelledError,
  SttError,
  type SttAudio,
  type SttProvider,
  type SttResult,
  type SttStatus,
} from "./provider.ts";
import { MAX_PROVIDER_RESPONSE_BYTES, readCapped } from "./transcript.ts";

// ── THE LOCAL-CLI PROVIDER (#227) ────────────────────────────────────────────────────────────
//
// One child per recording: `<command> [args…] <tempPath>`, and its trimmed stdout is the
// transcript. It is for an operator who already runs an on-device engine behind a command line
// (Muesli's `muesli-cli transcribe <file>`, a `whisper-cli` build) and should not have to stand up
// an HTTP server beside it to reach the `openai-compatible` provider. No audio leaves the host
// unless the operator's own command sends it somewhere.
//
// What the bridge gives up, said plainly: on this provider it SPAWNS A CHILD AS THE BRIDGE USER for
// every dictation (ADR 0029, addendum 2026-10-03). The bounds below are why that is acceptable:
//
//   • argv, never a shell — `Bun.spawn([command, ...args, path])`. Nothing is parsed, expanded or
//     globbed, so a stray character in the settings is an odd argument, not a second command.
//   • the operator's words only — `command` and `args` come from `stt.json` (0600, written by
//     `collie stt setup`) or the deployment's environment. The ONE value a request contributes is
//     the recording's bytes, written to a file whose name and extension Collie chose. The client's
//     content type picks the extension only through the allow-list in `bridge/stt/http.ts`, and it
//     is checked again here before it becomes part of a path.
//   • a private temp dir — `mkdtemp` under the OS temp dir, forced to 0700, the file written 0600
//     with `wx`, and the whole directory removed in `finally`, success or failure.
//   • the same 60 s deadline `openai-compatible` has, enforced with SIGKILL — a hung engine is
//     killed, not waited out, and not asked politely.
//   • a capped stdout — the same 256 KiB as an HTTP answer, refused mid-stream.
//   • stderr is never read and never forwarded. The phone gets Collie's own sentence and an exit
//     status; a command line or an engine's error output may name a path, a model or a token.
//   • no `COLLIE_*` variable is passed down. The bridge's environment carries the push keys and
//     the STT credential of other providers, none of which a transcription command needs.

/** The whole-call deadline, spawn to exit. The same budget `openai-compatible` has. */
export const LOCAL_CLI_TIMEOUT_MS = 60_000;

/** An extension Collie is willing to put in a path: short, lower-case, alphanumeric. */
const SAFE_EXTENSION = /^[a-z0-9]{1,5}$/;

/** Collie's sentence for a command that ran, exited 0, and printed nothing. */
const EMPTY_MESSAGE = "the local transcription command printed no transcript";

/**
 * A command that ran cleanly and printed nothing.
 *
 * A `refused` failure on the route, like any other unusable answer. It is its own class for one
 * reader: `collie stt test` sends generated SILENCE, and silence legitimately transcribes to
 * nothing, so that verb counts this one as the pass it is on every other provider.
 */
export class LocalCliEmptyTranscriptError extends SttError {
  constructor() {
    super("refused", EMPTY_MESSAGE);
    this.name = "LocalCliEmptyTranscriptError";
  }
}

/** The running child, as much of `Bun.spawn`'s answer as this provider touches. */
export interface LocalCliChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
}

export interface LocalCliSttDeps {
  /** The deadline, overridable so a test does not have to wait a minute to see one expire. */
  timeoutMs?: number;
  /** Where the private temp dir is made. The OS temp dir unless a test names its own. */
  tmpRoot?: string;
  /** The environment the child is built from, before `COLLIE_*` is dropped. */
  env?: Record<string, string | undefined>;
}

/**
 * A provider over one operator-named command. Nothing runs at construction time: the gate builds
 * this inside a snapshot poll, and a poll must stay free.
 */
export function createLocalCliSttProvider(
  settings: LocalCliSttSettings,
  deps: LocalCliSttDeps = {},
): SttProvider {
  const timeoutMs = deps.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS;
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  const env = childEnv(deps.env ?? process.env);

  return {
    id: settings.provider,

    /**
     * Whether the command is there to run. One `access` or one PATH walk, which is the cost of the
     * mtime check the gate already pays per poll. The reason names no path: it is shown on the phone.
     */
    async status(): Promise<SttStatus> {
      return commandRunnable(settings.command, env.PATH)
        ? { available: true }
        : { available: false, reason: "the local transcription command was not found on the host" };
    },

    async transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult> {
      const deadline = createSttDeadline(signal, timeoutMs);
      let dir: string | null = null;
      let child: LocalCliChild | null = null;
      // SIGKILL, not SIGTERM: the deadline is the end of the operator's wait, and an engine that
      // traps TERM to finish its model load would outlive it.
      const kill = (): void => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      deadline.signal.addEventListener("abort", kill, { once: true });
      try {
        deadline.throwIfAborted();
        dir = await mkdtemp(join(tmpRoot, "collie-stt-"));
        // mkdtemp already makes 0700 on every platform Bun runs on; said again so a umask or a
        // runtime change cannot widen it silently.
        await chmod(dir, 0o700);
        const path = join(dir, `recording.${extensionOf(input.filename)}`);
        await writeFile(path, input.audio, { mode: 0o600, flag: "wx" });
        deadline.throwIfAborted();

        child = spawnCommand([settings.command, ...settings.args, path], dir, env);
        const stdout = await deadline.wait(readCapped(new Response(child.stdout), deadline.signal));
        const status = await deadline.wait(child.exited);
        if (status !== 0) {
          // The status, and only the status. The command line and stderr stay on the host.
          throw new SttError("refused", `the local transcription command exited with status ${status}`);
        }
        const text = stdout.trim();
        if (text === "") throw new LocalCliEmptyTranscriptError();
        return { text };
      } catch (err) {
        kill();
        deadline.throwIfAborted();
        if (err instanceof SttError || err instanceof SttCancelledError) throw err;
        // A spawn that failed (no such file, not executable) or a temp dir that could not be made.
        // The cause is not attached: it is a string built from the operator's command line.
        throw new SttError("unavailable", "the local transcription command could not be run");
      } finally {
        deadline.signal.removeEventListener("abort", kill);
        if (dir !== null) {
          await rm(dir, { recursive: true, force: true }).catch(() => {
            /* a temp dir that will not go is the OS temp cleaner's, not a failed transcription */
          });
        }
      }
    },
  };
}

/** The real spawn: argv, no shell, stdin closed, stderr discarded unread. */
function spawnCommand(argv: string[], cwd: string, env: Record<string, string>): LocalCliChild {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return {
    stdout: proc.stdout,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal),
  };
}

/**
 * The extension the temp file gets. `bridge/stt/http.ts` already chose it from an allow-list of
 * nine content types; it is narrowed again here because this is where it becomes part of a path.
 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  return SAFE_EXTENSION.test(ext) ? ext : "bin";
}

/** The bridge's environment minus every `COLLIE_*` name, and minus unset values. */
export function childEnv(source: Record<string, string | undefined>) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.startsWith("COLLIE_")) continue;
    out[name] = value;
  }
  return out;
}

/** Whether `command` names something executable: itself when absolute, else a PATH hit. */
function commandRunnable(command: string, path: string | undefined): boolean {
  if (commandLookup(command) === "absolute") {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Bun.which(command, path === undefined ? {} : { PATH: path }) !== null;
}

/** Re-exported so a reader of this provider sees the cap it claims above without a second hop. */
export { MAX_PROVIDER_RESPONSE_BYTES };
