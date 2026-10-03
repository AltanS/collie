import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST, type Host } from "../host.ts";
import { systemTool } from "../icacls.ts";
import { commandLookup, type LocalCliSttSettings } from "./config.ts";
import { MAX_CONCURRENT_STT } from "./http.ts";
import {
  createSttDeadline,
  SttBusyError,
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
//   • the whole tree, not just the child — on Linux and macOS the command starts in a process group
//     of its own (`detached`), and every kill is `kill(-pgid, SIGKILL)`. A wrapper script whose
//     engine runs as ITS child would otherwise leave the engine running after the wrapper died. The
//     group is also killed after a clean exit, so nothing the command left behind in its group
//     outlives the call; a helper that means to stay must leave the group (`setsid`), as daemons do.
//     Windows has no process group to kill by a negative pid, so there the kill goes by PROCESS
//     TREE: `taskkill /PID <pid> /T /F`, by its absolute `%SystemRoot%\System32` path and as argv,
//     ends the command and every live process below it; then one PowerShell pass ends what the
//     command left behind after it exited, found by parent pid and by a start time inside the call
//     (so a reused pid is never taken for ours). Both run in the background, bounded, and never
//     throw. The one gap: a process whose own parent had already exited, and was not the command
//     itself, has no parent left to be found by.
//   • a capped stdout — the same 256 KiB as an HTTP answer, refused mid-stream, and the group (the
//     tree, on Windows) is killed at that moment, not at the deadline. The cap and the in-flight cap
//     below behave the same on every platform.
//   • a cap of its own on children in flight — {@link LOCAL_CLI_MAX_IN_FLIGHT}, refused before any
//     temp file or spawn — and a slot is only given back once the child has exited.
//   • a command that is a regular, executable file — checked by `status()` and by `collie stt`.
//   • stderr is never read and never forwarded. The phone gets Collie's own sentence and an exit
//     status; a command line or an engine's error output may name a path, a model or a token.
//   • no `COLLIE_*` variable is passed down. The bridge's environment carries the push keys and
//     the STT credential of other providers, none of which a transcription command needs.

/** The whole-call deadline, spawn to exit. The same budget `openai-compatible` has. */
export const LOCAL_CLI_TIMEOUT_MS = 60_000;

/**
 * The most local-cli children one bridge runs at once. The route already admits two transcriptions
 * per process (`MAX_CONCURRENT_STT`), and the phone's busy sentence says "two" in every language, so
 * this is that number, not a smaller one. It is enforced here as well because the route gives its
 * slot back the moment a caller disconnects, while a child may still be dying: this slot is only
 * returned once the child has exited (or {@link KILL_GRACE_MS} after the kill, if it will not).
 * An on-device engine is CPU- and memory-heavy, so a burst never becomes more engines than this.
 */
export const LOCAL_CLI_MAX_IN_FLIGHT = MAX_CONCURRENT_STT;

/** How long a killed child may take to exit before its slot is given back anyway. */
const KILL_GRACE_MS = 5_000;

/** The prefix of every temp dir this provider makes under the OS temp dir. */
export const LOCAL_CLI_TEMP_PREFIX = "collie-stt-";

/**
 * A temp dir older than this was left by a bridge that died mid-call (SIGKILL, power loss), because
 * no live call lasts more than {@link LOCAL_CLI_TIMEOUT_MS}. Swept once per process at provider load.
 */
export const STALE_TEMP_DIR_MS = 60 * 60 * 1000;

/** Children in flight across every provider instance in this process: the gate rebuilds providers. */
let inFlight = 0;

/** Temp roots already swept in this process, so a rebuilt provider does not sweep again. */
const swept = new Set<string>();

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
interface LocalCliChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /**
   * SIGKILL the child's whole process group (POSIX), or end its process tree (Windows: `taskkill /T`,
   * then the orphan pass). Never throws, and on Windows never waits.
   */
  killTree(): void;
}

export interface LocalCliSttDeps {
  /** The deadline, overridable so a test does not have to wait a minute to see one expire. */
  timeoutMs?: number;
  /** Where the private temp dir is made. The OS temp dir unless a test names its own. */
  tmpRoot?: string;
  /** The environment the child is built from, before `COLLIE_*` is dropped. */
  env?: Record<string, string | undefined>;
  /** The platform facts the spawn branches on. The machine's own unless a test pins one. */
  host?: Host;
}

/**
 * A provider over one operator-named command. Nothing is spawned at construction time: the gate
 * builds this inside a snapshot poll, and a poll must stay free. The one thing construction starts is
 * the stale temp dir sweep, once per process and temp root, in the background and never awaited.
 */
export function createLocalCliSttProvider(
  settings: LocalCliSttSettings,
  deps: LocalCliSttDeps = {},
): SttProvider {
  const timeoutMs = deps.timeoutMs ?? LOCAL_CLI_TIMEOUT_MS;
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  const env = childEnv(deps.env ?? process.env);
  const host = deps.host ?? HOST;
  if (!swept.has(tmpRoot)) {
    swept.add(tmpRoot);
    void sweepStaleTempDirs(tmpRoot).catch(() => {
      /* a sweep that fails leaves the dirs to the OS temp cleaner, as before */
    });
  }

  return {
    id: settings.provider,

    /**
     * Whether the command is there to run: a regular, executable file (see {@link commandFileProblem}).
     * One `stat` and one `access`, or one PATH walk first, which is the cost of the mtime check the
     * gate already pays per poll. The reason names no path and no cause: it is shown on the phone.
     * `collie stt status` on the host says which check failed.
     */
    async status(): Promise<SttStatus> {
      return commandRunnable(settings.command, env.PATH)
        ? { available: true }
        : { available: false, reason: "the local transcription command was not found on the host, or cannot be run" };
    },

    async transcribe(input: SttAudio, signal?: AbortSignal): Promise<SttResult> {
      // Refused before anything touches the disk or the process table.
      if (inFlight >= LOCAL_CLI_MAX_IN_FLIGHT) throw new SttBusyError();
      inFlight += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };

      const deadline = createSttDeadline(signal, timeoutMs);
      let dir: string | null = null;
      let child: LocalCliChild | null = null;
      // SIGKILL, not SIGTERM: the deadline is the end of the operator's wait, and an engine that
      // traps TERM to finish its model load would outlive it. The whole group, see the header.
      const kill = (): void => child?.killTree();
      deadline.signal.addEventListener("abort", kill, { once: true });
      try {
        deadline.throwIfAborted();
        dir = await mkdtemp(join(tmpRoot, LOCAL_CLI_TEMP_PREFIX));
        // mkdtemp already makes 0700 on every platform Bun runs on; said again so a umask or a
        // runtime change cannot widen it silently.
        await chmod(dir, 0o700);
        const path = join(dir, `recording.${extensionOf(input.filename)}`);
        await writeFile(path, input.audio, { mode: 0o600, flag: "wx" });
        deadline.throwIfAborted();

        child = spawnCommand([settings.command, ...settings.args, path], dir, env, host);
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
        // After a clean exit too: a straggler the command left in its group goes with it.
        kill();
        // The slot is the CHILD's, not the call's: given back when it has exited, which after a
        // SIGKILL is at once, or after a grace period for a child stuck in the kernel.
        if (child === null) release();
        else void Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS)]).then(release, release);
        if (dir !== null) {
          await rm(dir, { recursive: true, force: true }).catch(() => {
            /* a temp dir that will not go is the OS temp cleaner's, not a failed transcription */
          });
        }
      }
    },
  };
}

/**
 * The real spawn: argv, no shell, stdin closed, stderr discarded unread.
 *
 * On POSIX the child is `detached`, which makes it the leader of a new process group (its pgid is
 * its pid), so `kill(-pid)` reaches everything it forked that did not leave the group. On Windows
 * `detached` means a new console and a negative pid means nothing, so the child is spawned as before
 * and its tree is ended by {@link windowsTreeKill}, once, whichever of the deadline, the stdout cap
 * or the clean exit asks first.
 */
function spawnCommand(argv: string[], cwd: string, env: Record<string, string>, host: Host): LocalCliChild {
  const group = host.platform !== "win32";
  const startedAt = Date.now();
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: group });
  let treeKilled = false;
  return {
    stdout: proc.stdout,
    exited: proc.exited,
    killTree() {
      const leader = (): void => {
        try {
          // The leader itself, in case the group or tree kill was refused; a no-op once it has exited.
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      if (!group) {
        // taskkill walks the tree from the live command, so the command is killed after it, not before.
        if (treeKilled) return;
        treeKilled = true;
        windowsTreeKill(proc.pid, startedAt, env, leader);
        return;
      }
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* ESRCH: the group is already empty */
      }
      leader();
    },
  };
}

/** How long each of the two Windows kill programs may run before it is itself ended. */
export const WINDOWS_KILL_TIMEOUT_MS = 15_000;

/** Milliseconds since the epoch as a Windows FILETIME (100 ns ticks since 1601), for PowerShell. */
const fileTime = (ms: number): string => ((BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n).toString();

/**
 * The PowerShell pass that ends what the command left behind. One snapshot of the process table,
 * taken before anything is killed; from it, every process whose parent is `pid` and that started
 * between `fromMs` and `toMs` (the call's own window, so a process of a later owner of a reused pid
 * is never taken), then their children, and theirs, each started after its parent. Numbers only are
 * spliced in, so nothing from the operator's settings reaches the script.
 */
export function windowsOrphanScript(pid: number, fromMs: number, toMs: number): string {
  return [
    `$from = [datetime]::FromFileTimeUtc(${fileTime(fromMs)}); $to = [datetime]::FromFileTimeUtc(${fileTime(toMs)})`,
    "$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; At = $_.CreationDate.ToUniversalTime() } })",
    `$queue = New-Object System.Collections.Queue; $queue.Enqueue(@(${pid}, $from, $to)); $found = @{}`,
    "while ($queue.Count -gt 0) { $q = $queue.Dequeue(); foreach ($p in $all) { if ($p.Parent -eq $q[0] -and $p.At -ge $q[1] -and $p.At -le $q[2] -and -not $found.ContainsKey($p.Id)) { $found[$p.Id] = $true; $queue.Enqueue(@($p.Id, $p.At, [datetime]::MaxValue)) } } }",
    "foreach ($id in $found.Keys) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
}

/**
 * The two programs that end a Windows command's tree, as argv with absolute paths (never a PATH
 * lookup): `taskkill /T /F` for the live tree, then the orphan pass. `toMs` has a few seconds of
 * slack past now, for a grandchild started in the instant before the kill.
 */
export function windowsKillCommands(pid: number, startedAt: number, now: number, env: Readonly<Record<string, string | undefined>>): string[][] {
  return [
    [systemTool(env, "taskkill.exe"), "/PID", String(pid), "/T", "/F"],
    [
      systemTool(env, "WindowsPowerShell", "v1.0", "powershell.exe"),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsOrphanScript(pid, startedAt - 1_000, now + 5_000),
    ],
  ];
}

/**
 * Run {@link windowsKillCommands} one after the other, in the background, and kill the command
 * itself (`leader`) right after taskkill, as the POSIX path does after its group kill. Never throws,
 * never waits.
 */
function windowsTreeKill(pid: number, startedAt: number, env: Readonly<Record<string, string | undefined>>, leader: () => void): void {
  const [taskkill, orphans] = windowsKillCommands(pid, startedAt, Date.now(), env);
  const run = async (argv: string[] | undefined): Promise<void> => {
    if (argv === undefined) return;
    try {
      const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: WINDOWS_KILL_TIMEOUT_MS });
      await p.exited;
    } catch {
      /* no taskkill or no PowerShell: the child itself is still killed below */
    }
  };
  void run(taskkill)
    .then(leader)
    .then(() => run(orphans));
}

/**
 * Remove temp dirs a previous bridge left behind when it was killed mid-call, from under `root`.
 *
 * Only entries that are, without following a symlink, a DIRECTORY named {@link LOCAL_CLI_TEMP_PREFIX}…,
 * OWNED BY THIS USER, and last modified more than {@link STALE_TEMP_DIR_MS} ago. No live call is that
 * old, so this never races a transcription, in this bridge or in a sibling bridge of the same user.
 * Another user's dir is never touched, and in a sticky `/tmp` it cannot be swapped in under us.
 * Skipped on Windows, where there is no uid to prove ownership by. Returns how many it removed.
 */
export async function sweepStaleTempDirs(
  root: string,
  now: number = Date.now(),
  uid: number | null = process.getuid?.() ?? null,
): Promise<number> {
  if (uid === null) return 0;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(LOCAL_CLI_TEMP_PREFIX)) continue;
    const path = join(root, name);
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.uid !== uid || now - entry.mtimeMs < STALE_TEMP_DIR_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed;
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

/**
 * Why `path` cannot be run as the local-cli command, or null when it can. The answer is an
 * OPERATOR's sentence for `collie stt` on the host: it is never put on the wire, because the bridge's
 * own status reason names no path and no cause.
 *
 * Symlinks are FOLLOWED (`stat`, not `lstat`): a `/usr/local/bin/whisper-cli` that links into a
 * versioned install is the ordinary case, and what must hold is that the TARGET is a regular file
 * this user may execute. On Windows `X_OK` reads as "exists" (there is no execute bit), so there the
 * check is "a regular file".
 */
export function commandFileProblem(path: string): string | null {
  let entry;
  try {
    entry = statSync(path);
  } catch {
    return "does not exist (or is a symlink to nothing)";
  }
  if (entry.isDirectory()) return "is a directory, not a program";
  if (!entry.isFile()) return "is not a regular file";
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    return "is not executable by this user (chmod +x it)";
  }
  return null;
}

/** Whether `command` names something runnable: itself when absolute, else a PATH hit, checked alike. */
function commandRunnable(command: string, path: string | undefined): boolean {
  const found = commandLookup(command) === "absolute"
    ? command
    : Bun.which(command, path === undefined ? {} : { PATH: path });
  return found !== null && commandFileProblem(found) === null;
}

/** Re-exported so a reader of this provider sees the cap it claims above without a second hop. */
export { MAX_PROVIDER_RESPONSE_BYTES };
