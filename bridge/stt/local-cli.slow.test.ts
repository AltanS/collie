// The slow cases of local-cli.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostFor } from "../host.ts";
import type { LocalCliSttSettings } from "./config.ts";
import { createLocalCliSttProvider, type LocalCliSttDeps } from "./local-cli.ts";
import { SttCancelledError, SttError, type SttAudio } from "./provider.ts";

// The local-cli provider against a FAKE transcription command: a small script run by this very
// Bun, so the suite needs no shell and runs the same on Linux, macOS and Windows. Every case spawns a
// real child, because the things worth pinning (argv not a shell, the temp file's life, SIGKILL on
// the deadline, the stdout cap) only exist with one.

let root: string;

let tmpRoot: string;

let scripts: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "collie-local-cli-test-"));
  tmpRoot = join(root, "tmp");
  scripts = join(root, "scripts");
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

describe("local-cli — failures are clean and say nothing of the host", () => {
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

/**
 * A script body that starts a grandchild (a 30 s Bun sleep), records its pid, then runs `then`.
 *
 * On Windows the grandchild is spawned `detached`. Without it, libuv puts every child Bun starts in
 * a job object that kills it when the starting process dies (checked on the Windows 11 VM), so a Bun
 * fixture would clean up after itself and prove nothing. A real engine started by a wrapper has no
 * such job. Detached there keeps the parent pid, which is what the tree kill follows. On POSIX it
 * stays in the group, which is what the group kill follows.
 */
function forker(pidFile: string, then: string): string {
  return `
const kid = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: process.platform === "win32",
});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
${then}
`;
}

const pidIn = (file: string): number => Number(readFileSync(file, "utf8"));

/**
 * How long a killed tree may take to go. POSIX kills the group at once; Windows runs taskkill and
 * then a PowerShell pass for orphans, and PowerShell alone can take seconds to start.
 */
const TREE_GONE_MS = posix ? 5_000 : 30_000;

describe("local-cli — the whole process tree goes (POSIX process group, Windows process tree)", () => {
  test("the deadline kills the grandchild too", async () => {
    const pidFile = join(root, "tree-deadline.pid");
    const settings = fakeCommand("tree-deadline", forker(pidFile, "await Bun.sleep(30_000);"));
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps({ timeoutMs: 1_500 })).transcribe(clip()));
    expect(err.kind).toBe("timeout");
    await waitUntil(() => !alive(pidIn(pidFile)), TREE_GONE_MS, "the grandchild to die");
    expect(tempRootIsEmpty()).toBe(true);
  }, 40_000);

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
