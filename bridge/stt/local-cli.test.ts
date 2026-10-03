import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalCliSttSettings } from "./config.ts";
import {
  childEnv,
  createLocalCliSttProvider,
  extensionOf,
  LocalCliEmptyTranscriptError,
  type LocalCliSttDeps,
} from "./local-cli.ts";
import { SttCancelledError, SttError, type SttAudio } from "./provider.ts";

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

  test("a stdout past the cap is refused mid-stream as oversized", async () => {
    const settings = fakeCommand("loud", `process.stdout.write("x".repeat(300 * 1024));`);
    const err = await sttFailureOf(createLocalCliSttProvider(settings, deps()).transcribe(clip()));
    expect(err.kind).toBe("oversized");
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
