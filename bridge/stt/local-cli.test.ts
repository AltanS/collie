import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostFor } from "../host.ts";
import type { LocalCliSttSettings } from "./config.ts";
import {
  childEnv,
  commandFileProblem,
  createLocalCliSttProvider,
  extensionOf,
  LOCAL_CLI_MAX_IN_FLIGHT,
  LOCAL_CLI_TEMP_PREFIX,
  LocalCliEmptyTranscriptError,
  STALE_TEMP_DIR_MS,
  sweepStaleTempDirs,
  type LocalCliSttDeps,
  windowsKillCommands,
  windowsOrphanScript,
} from "./local-cli.ts";
import { SttBusyError, SttCancelledError, SttError, type SttAudio } from "./provider.ts";

// The local-cli provider against a FAKE transcription command: a small script run by this very
// Bun, so the suite needs no shell and runs the same on Linux, macOS and Windows. Every case spawns a
// real child, because the things worth pinning (argv not a shell, the temp file's life, SIGKILL on
// the deadline, the stdout cap) only exist with one.

let root: string;
let tmpRoot: string;
let scripts: string;
let report: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "collie-local-cli-test-"));
  tmpRoot = join(root, "tmp");
  scripts = join(root, "scripts");
  report = join(root, "report.json");
  for (const dir of [tmpRoot, scripts]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a fake command and return settings that run it as `bun <script> [args…] <path>`. */
function fakeCommand(name: string, body: string, args: string[] = []): LocalCliSttSettings {
  const path = join(scripts, `${name}.ts`);
  writeFileSync(path, body);
  return { provider: "local-cli", command: process.execPath, args: [path, ...args] };
}

/** A script that records what it saw (argv, the file, its modes, its env) and prints `out`. */
function recorder(out: string): string {
  return `
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const argv = process.argv.slice(2);
const file = argv[argv.length - 1];
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  argv,
  bytes: [...readFileSync(file)],
  fileMode: statSync(file).mode & 0o777,
  dirMode: statSync(dirname(file)).mode & 0o777,
  collieEnv: Object.keys(process.env).filter((k) => k.startsWith("COLLIE_")),
  marker: process.env.LOCAL_CLI_MARKER ?? null,
}));
process.stdout.write(${JSON.stringify(out)});
`;
}

interface Report {
  argv: string[];
  bytes: number[];
  fileMode: number;
  dirMode: number;
  collieEnv: string[];
  marker: string | null;
}

function readReport(): Report {
  // SAFETY: the file is the fake command's own JSON.stringify of exactly this shape.
  return JSON.parse(readFileSync(report, "utf8")) as Report;
}

const clip = (filename = "recording.webm"): SttAudio => ({
  audio: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/webm;codecs=opus",
  filename,
});

const deps = (over: LocalCliSttDeps = {}): LocalCliSttDeps => ({ tmpRoot, ...over });

/** Nothing this provider made is left under its temp root. */
const tempRootIsEmpty = (): boolean => readdirSync(tmpRoot).length === 0;


/** What a transcription threw, narrowed to the two errors a provider may throw; anything else fails. */
async function failureOf(work: Promise<unknown>): Promise<SttError | SttCancelledError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof SttError || err instanceof SttCancelledError) return err;
    throw new Error(`not a provider error: ${String(err)}`, { cause: err });
  }
  throw new Error("expected the transcription to fail");
}

/** {@link failureOf}, for the cases that expect a provider failure rather than a cancellation. */
async function sttFailureOf(work: Promise<unknown>): Promise<SttError> {
  const failure = await failureOf(work);
  if (failure instanceof SttError) return failure;
  throw new Error("expected an SttError, got a cancellation");
}

const posix = process.platform !== "win32";

describe("local-cli — a transcript", () => {
  test("stdout, trimmed, is the transcript; argv is args then the recording's path", async () => {
    const settings = fakeCommand("echo", recorder("  hello from the engine \n"), ["transcribe", "--lang", "en"]);
    const provider = createLocalCliSttProvider(settings, deps());
    expect(provider.id).toBe("local-cli");
    expect(await provider.transcribe(clip())).toEqual({ text: "hello from the engine" });

    const seen = readReport();
    expect(seen.argv.slice(0, 3)).toEqual(["transcribe", "--lang", "en"]);
    expect(seen.argv).toHaveLength(4);
    expect(seen.argv[3]!.startsWith(join(tmpRoot, "collie-stt-"))).toBe(true);
    expect(seen.argv[3]!.endsWith("recording.webm")).toBe(true);
    expect(seen.bytes).toEqual([1, 2, 3, 4]);
    if (posix) {
      expect(seen.fileMode).toBe(0o600);
      expect(seen.dirMode).toBe(0o700);
    }
    // Deleted in `finally`: the recording does not outlive the request.
    expect(existsSync(seen.argv[3]!)).toBe(false);
    expect(tempRootIsEmpty()).toBe(true);
  });

  test("no shell reads the arguments: metacharacters arrive literally", async () => {
    const hostile = ["$(touch pwned)", "; rm -rf /", "`id`", "a b", "*"];
    const settings = fakeCommand("literal", recorder("ok"), hostile);
    await createLocalCliSttProvider(settings, deps()).transcribe(clip());
    expect(readReport().argv.slice(0, hostile.length)).toEqual(hostile);
    expect(existsSync(join(scripts, "pwned"))).toBe(false);
  });

  test("the request's filename never becomes a path; only a safe extension survives", async () => {
    const settings = fakeCommand("ext", recorder("ok"));
    await createLocalCliSttProvider(settings, deps()).transcribe(clip("../../etc/passwd.x/../sh"));
    const path = readReport().argv.at(-1)!;
    expect(path.endsWith("recording.bin")).toBe(true);
  });

  test("no COLLIE_* variable reaches the child; the rest of the environment does", async () => {
    const settings = fakeCommand("env", recorder("ok"));
    const env = { ...process.env, COLLIE_STT_KEY: "sk-secret", COLLIE_VAPID_PRIVATE: "x", LOCAL_CLI_MARKER: "kept" };
    await createLocalCliSttProvider(settings, deps({ env })).transcribe(clip());
    const seen = readReport();
    expect(seen.collieEnv).toEqual([]);
    expect(seen.marker).toBe("kept");
  });
});

describe("local-cli — failures are clean and say nothing of the host", () => {
  test("a non-zero exit is refused with its status, never its stderr or command line", async () => {
    const settings = fakeCommand(
      "fails",
      `process.stderr.write("secret-token-in-stderr /home/me/models"); process.exit(3);`,
      ["--token", "sk-in-args"],
    );
    const stt = await sttFailureOf(createLocalCliSttProvider(settings, deps()).transcribe(clip()));
    expect(stt.kind).toBe("refused");
    expect(stt.message).toBe("the local transcription command exited with status 3");
    expect(stt.message).not.toContain("secret");
    expect(stt.message).not.toContain("sk-in-args");
    expect(stt.message).not.toContain(process.execPath);
    expect(tempRootIsEmpty()).toBe(true);
  });

  test("an empty stdout is refused, as its own class so `stt test` can tell silence apart", async () => {
    const settings = fakeCommand("empty", `process.stdout.write("  \\n\\n");`);
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps()).transcribe(clip()));
    expect(err).toBeInstanceOf(LocalCliEmptyTranscriptError);
    expect(err.kind).toBe("refused");
  });

  test("a stdout past the cap is refused mid-stream as oversized, and the child is killed then", async () => {
    // The command writes past the cap and then would sit for 30 s, deaf to a closed pipe. The
    // deadline is 30 s too, so only a kill AT the cap can end it inside the bound below.
    const pidFile = join(root, "loud.pid");
    const settings = fakeCommand(
      "loud",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       process.stdout.on("error", () => {});
       process.on("uncaughtException", () => {});
       process.on("SIGPIPE", () => {});
       process.stdout.write("x".repeat(300 * 1024));
       await Bun.sleep(30_000);`,
    );
    const started = Date.now();
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps({ timeoutMs: 30_000 })).transcribe(clip()));
    expect(err.kind).toBe("oversized");
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitUntil(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    expect(tempRootIsEmpty()).toBe(true);
  });

  test("a command that cannot be started is unavailable, and names no path", async () => {
    const missing = join(root, "no-such-engine");
    const provider = createLocalCliSttProvider({ provider: "local-cli", command: missing, args: [] }, deps());
    const err = await sttFailureOf(provider.transcribe(clip()));
    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain(missing);
    expect(tempRootIsEmpty()).toBe(true);
  });

  test("the deadline SIGKILLs the child and answers timeout", async () => {
    const pidFile = join(root, "hung.pid");
    const settings = fakeCommand(
      "hung",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       process.on("SIGTERM", () => {}); await Bun.sleep(30_000);`,
    );
    const started = Date.now();
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps({ timeoutMs: 1_500 }))
      .transcribe(clip()));
    expect(err.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(200);
    expect(alive(pid)).toBe(false);
    expect(tempRootIsEmpty()).toBe(true);
  });

  test("a caller that stops waiting cancels, and the child is killed", async () => {
    const pidFile = join(root, "cancel.pid");
    const settings = fakeCommand(
      "cancel",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`,
    );
    const controller = new AbortController();
    const pending = createLocalCliSttProvider(settings, deps()).transcribe(clip(), controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    controller.abort();
    const err = await failureOf(pending);
    expect(err).toBeInstanceOf(SttCancelledError);
    await Bun.sleep(200);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(tempRootIsEmpty()).toBe(true);
  });
});

describe("local-cli — status", () => {
  test("an existing command is available", async () => {
    const settings: LocalCliSttSettings = { provider: "local-cli", command: process.execPath, args: [] };
    expect(await createLocalCliSttProvider(settings, deps()).status()).toEqual({ available: true });
  });

  test("a missing command is unavailable, and the reason names no path", async () => {
    const missing = join(root, "gone");
    const status = await createLocalCliSttProvider(
      { provider: "local-cli", command: missing, args: [] },
      deps(),
    ).status();
    expect(status.available).toBe(false);
    expect(status.reason).not.toContain(missing);
  });

  test("a bare name is looked up on the child's PATH", async () => {
    const status = await createLocalCliSttProvider(
      { provider: "local-cli", command: "collie-no-such-command-anywhere", args: [] },
      deps(),
    ).status();
    expect(status.available).toBe(false);
  });
});

describe("local-cli — the small pure helpers", () => {
  test("extensionOf keeps a short alphanumeric extension and falls back to bin", () => {
    expect(extensionOf("recording.webm")).toBe("webm");
    expect(extensionOf("recording.M4A")).toBe("m4a");
    expect(extensionOf("recording")).toBe("bin");
    expect(extensionOf("x.we/bm")).toBe("bin");
    expect(extensionOf("x.toolongext")).toBe("bin");
  });

  test("childEnv drops COLLIE_* and unset values", () => {
    expect(childEnv({ PATH: "/bin", COLLIE_STT_KEY: "k", HOME: undefined })).toEqual({ PATH: "/bin" });
  });
});

/** Whether `pid` is a live process. A zombie (killed, not yet reaped by whoever adopted it) is dead. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    // `/proc/<pid>/stat`: "pid (comm) S …", the state letter after the last `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

/** Poll `check` for up to `ms`; fail the test with `what` if it never holds. */
async function waitUntil(check: () => boolean, ms = 5_000, what = "condition"): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A script body that starts a grandchild (a 30 s Bun sleep), records its pid, then runs `then`. */
function forker(pidFile: string, then: string): string {
  return `
const kid = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore",
});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
${then}
`;
}

/** The first transcript `settings` gives within a second, retrying while every slot is busy. */
async function firstAnswer(settings: LocalCliSttSettings): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    try {
      return (await createLocalCliSttProvider(settings, deps()).transcribe(clip())).text;
    } catch (err) {
      if (!(err instanceof SttBusyError)) throw err;
      await Bun.sleep(25);
    }
  }
  return null;
}

const pidIn = (file: string): number => Number(readFileSync(file, "utf8"));

/**
 * How long a killed tree may take to go. POSIX kills the group at once; Windows runs taskkill and
 * then a PowerShell pass for orphans, and PowerShell alone can take seconds to start.
 */
const TREE_GONE_MS = posix ? 5_000 : 30_000;

describe("local-cli — the whole process tree goes (POSIX process group, Windows process tree)", () => {
  test("the fixture is real: killing only the parent leaves the grandchild running", async () => {
    // What the group kill exists for, shown without it: a plain SIGKILL to the parent orphans the
    // grandchild, which then runs on for its full 30 s.
    const pidFile = join(root, "control.pid");
    const script = join(scripts, "control.ts");
    writeFileSync(script, forker(pidFile, "await Bun.sleep(30_000);"));
    const parent = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    await waitUntil(() => existsSync(pidFile), 5_000, "the grandchild's pid");
    parent.kill("SIGKILL");
    await parent.exited;
    const grandchild = pidIn(pidFile);
    await Bun.sleep(200);
    expect(alive(grandchild)).toBe(true);
    process.kill(grandchild, "SIGKILL");
  });

  test("the deadline kills the grandchild too", async () => {
    const pidFile = join(root, "tree-deadline.pid");
    const settings = fakeCommand("tree-deadline", forker(pidFile, "await Bun.sleep(30_000);"));
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps({ timeoutMs: 1_500 })).transcribe(clip()));
    expect(err.kind).toBe("timeout");
    await waitUntil(() => !alive(pidIn(pidFile)), TREE_GONE_MS, "the grandchild to die");
    expect(tempRootIsEmpty()).toBe(true);
  }, 40_000);

  test("a straggler left behind after a clean exit is killed too", async () => {
    const pidFile = join(root, "tree-clean.pid");
    const settings = fakeCommand("tree-clean", forker(pidFile, `process.stdout.write("done"); process.exit(0);`));
    expect(await createLocalCliSttProvider(settings, deps()).transcribe(clip())).toEqual({ text: "done" });
    await waitUntil(() => !alive(pidIn(pidFile)), TREE_GONE_MS, "the straggler to die");
  }, 40_000);

  test("the Windows kill is two programs by absolute path, as argv, with numbers only in the script", () => {
    const [taskkill, orphans] = windowsKillCommands(4242, 1_000_000, 2_000_000, { SystemRoot: "D:\\WINNT" });
    expect(taskkill).toEqual(["D:\\WINNT\\System32\\taskkill.exe", "/PID", "4242", "/T", "/F"]);
    expect(orphans?.slice(0, 4)).toEqual([
      "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    // No SystemRoot: C:\Windows, never a PATH lookup.
    expect(windowsKillCommands(1, 0, 0, {})[0]?.[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
    // The window: one second before the spawn to five seconds after the kill, as FILETIME ticks.
    const script = orphans?.[4] ?? "";
    expect(script).toContain(`FromFileTimeUtc(${(999_000n + 11_644_473_600_000n) * 10_000n})`);
    expect(script).toContain(`FromFileTimeUtc(${(2_005_000n + 11_644_473_600_000n) * 10_000n})`);
    expect(script).toContain("$queue.Enqueue(@(4242, $from, $to))");
    // Parent pid AND start time decide; then each child's children, started after it.
    expect(script).toContain("$p.Parent -eq $q[0] -and $p.At -ge $q[1] -and $p.At -le $q[2]");
    expect(script).toContain("Stop-Process -Id $id -Force");
    expect(windowsOrphanScript(7, 0, 0)).toBe(windowsKillCommands(7, 1_000, -5_000, {})[1]?.[4] ?? "");
  });

  test("on a Windows host the child is spawned without a group and still killed at the deadline", async () => {
    // Pinned host: the Windows branch (no `detached`, kill the child alone) runs here on Linux.
    const pidFile = join(root, "win.pid");
    const settings = fakeCommand(
      "win",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`,
    );
    const err = await sttFailureOf(
      createLocalCliSttProvider(settings, deps({ timeoutMs: 1_000, host: hostFor("win32") })).transcribe(clip()),
    );
    expect(err.kind).toBe("timeout");
    await waitUntil(() => !alive(pidIn(pidFile)), 5_000, "the child to die");
  });
});

describe("local-cli — at most LOCAL_CLI_MAX_IN_FLIGHT children at once", () => {
  test("the next request is busy, spawns nothing and writes nothing; a slot returns when its child exits", async () => {
    // A child an earlier test killed gives its slot back when Bun has reaped it, a tick or so after
    // it died. Start from a provider that answers, so every slot is free.
    expect(await firstAnswer(fakeCommand("busy-probe", `process.stdout.write("ready");`))).toBe("ready");
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    const pids: string[] = [];
    for (let i = 0; i < LOCAL_CLI_MAX_IN_FLIGHT; i++) {
      const pidFile = join(root, `busy-${i}.pid`);
      pids.push(pidFile);
      const settings = fakeCommand(
        `busy-${i}`,
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`,
      );
      const controller = new AbortController();
      controllers.push(controller);
      pending.push(failureOf(createLocalCliSttProvider(settings, deps()).transcribe(clip(), controller.signal)));
    }
    for (const file of pids) await waitUntil(() => existsSync(file), 5_000, "the busy children");
    const dirsWhileFull = readdirSync(tmpRoot).length;

    const marker = join(root, "busy-spawned");
    const extra = fakeCommand("busy-extra", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
    // A NEW provider instance: the cap is per bridge process, not per provider object.
    await expect(createLocalCliSttProvider(extra, deps()).transcribe(clip())).rejects.toBeInstanceOf(SttBusyError);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(tmpRoot).length).toBe(dirsWhileFull);

    for (const c of controllers) c.abort();
    await Promise.all(pending);
    for (const file of pids) await waitUntil(() => !alive(pidIn(file)), 5_000, "the busy children to die");
    expect(await firstAnswer(fakeCommand("busy-after", `process.stdout.write("free again");`))).toBe("free again");
  });
});

describe("local-cli — the command must be a regular, executable file", () => {
  // POSIX only: Windows has no executable bit, and making a symlink there needs a privilege.
  test.if(posix)("commandFileProblem: regular executable passes, symlinks are followed", () => {
    const dir = mkdtempSync(join(root, "cmd-"));
    const exe = join(dir, "engine");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    const plain = join(dir, "plain");
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    symlinkSync(exe, join(dir, "to-exe"));
    symlinkSync(sub, join(dir, "to-dir"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));

    expect(commandFileProblem(exe)).toBeNull();
    expect(commandFileProblem(join(dir, "to-exe"))).toBeNull();
    expect(commandFileProblem(plain)).toContain("not executable");
    expect(commandFileProblem(sub)).toContain("directory");
    expect(commandFileProblem(join(dir, "to-dir"))).toContain("directory");
    expect(commandFileProblem(join(dir, "dangling"))).toContain("does not exist");
    expect(commandFileProblem(join(dir, "missing"))).toContain("does not exist");
    if (existsSync("/dev/null")) expect(commandFileProblem("/dev/null")).toBe("is not a regular file");
  });

  // POSIX only: the non-executable half has no Windows meaning (no executable bit).
  test.if(posix)("status refuses a directory and a non-executable file, and names neither", async () => {
    const dir = mkdtempSync(join(root, "status-"));
    const plain = join(dir, "plain");
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);
    for (const command of [dir, plain]) {
      const status = await createLocalCliSttProvider({ provider: "local-cli", command, args: [] }, deps()).status();
      expect(status.available).toBe(false);
      expect(status.reason).not.toContain(command);
    }
  });
});

describe("local-cli — stale temp dirs from a killed bridge", () => {
  const old = (path: string): void => {
    const then = (Date.now() - STALE_TEMP_DIR_MS - 60_000) / 1000;
    utimesSync(path, then, then);
  };

  // POSIX only: the sweep proves ownership by uid, which Windows does not have ("no uid" below).
  test.if(posix)("only an old directory with the prefix, owned by this user, is removed", async () => {
    const sweepRoot = mkdtempSync(join(root, "sweep-"));
    const stale = join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}stale`);
    mkdirSync(stale);
    writeFileSync(join(stale, "recording.webm"), "x");
    old(stale);
    const fresh = join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}fresh`);
    mkdirSync(fresh);
    const foreign = join(sweepRoot, "other-tool-dir");
    mkdirSync(foreign);
    old(foreign);
    const file = join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}file`);
    writeFileSync(file, "x");
    old(file);
    // A symlink with the prefix, pointing at an old dir elsewhere: neither the link's target nor
    // its contents may go, because the sweep never follows a link.
    const target = mkdtempSync(join(root, "link-target-"));
    writeFileSync(join(target, "keep"), "x");
    old(target);
    symlinkSync(target, join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}link`));

    // Another user's uid removes nothing.
    expect(await sweepStaleTempDirs(sweepRoot, Date.now(), (process.getuid?.() ?? 0) + 1)).toBe(0);
    expect(existsSync(stale)).toBe(true);

    expect(await sweepStaleTempDirs(sweepRoot)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(target, "keep"))).toBe(true);
  });

  test("no uid (Windows) sweeps nothing", async () => {
    const sweepRoot = mkdtempSync(join(root, "sweep-win-"));
    const stale = join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}stale`);
    mkdirSync(stale);
    old(stale);
    expect(await sweepStaleTempDirs(sweepRoot, Date.now(), null)).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  // POSIX only: on Windows the sweep removes nothing (no uid), so there is nothing to see it do.
  test.if(posix)("loading the provider sweeps its temp root once, in the background", async () => {
    const sweepRoot = mkdtempSync(join(root, "sweep-load-"));
    const stale = join(sweepRoot, `${LOCAL_CLI_TEMP_PREFIX}left-behind`);
    mkdirSync(stale);
    old(stale);
    createLocalCliSttProvider({ provider: "local-cli", command: process.execPath, args: [] }, { tmpRoot: sweepRoot });
    await waitUntil(() => !existsSync(stale), 5_000, "the load-time sweep");
  });
});
