import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// A quit must not end pi's process before the clear lands, and must not leave `hc` behind. Only a
// process of its own shows whether the extension holds the event loop, because the test runner keeps
// its own loop alive. The child is `collie-session-label.exit-driver.ts`. Pi runs on node, and on node
// an `unref`ed timer or child lets the process end in the middle of a quit (the bun that runs this
// test does not), so the driver runs under node too when a node that strips types is on the PATH.

const POSIX = process.platform !== "win32";
const DRIVER = join(import.meta.dir, "collie-session-label.exit-driver.ts");
const TERMINAL = "exit-t1";

/** The runtimes to start the driver with: this bun, and a node (24 or newer runs a `.ts` file as it is) when there is one. */
function runtimes(): [string, string][] {
  const found: [string, string][] = [["bun", process.execPath]];
  const node = Bun.which("node");
  if (node === null) return found;
  const major = Number(/^v(\d+)/u.exec(spawnSync(node, ["--version"], { encoding: "utf8" }).stdout)?.[1] ?? 0);
  return major >= 24 ? [...found, ["node", node]] : found;
}

let dir = "";
const pidFile = () => join(dir, "pids.txt");
const childFile = () => join(dir, "children.txt");

/** The numbers a file holds, one per line, or none. */
function numbersIn(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fake `hc` that records its call, then runs `after` (a shell line). */
function writeHc(after: string): string {
  const record = join(dir, "record.txt");
  const file = join(dir, "hc");
  const lines = [
    "#!/bin/sh",
    `echo $$ >> "${pidFile()}"`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> "${record}"; done`,
    `printf '%s\\n' '--call--' >> "${record}"`,
    after,
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  chmodSync(file, 0o755);
  return file;
}

function calls(): string[][] {
  const record = join(dir, "record.txt");
  if (!existsSync(record)) return [];
  const lines = readFileSync(record, "utf8").split("\n");
  lines.pop();
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line !== "--call--") current.push(line);
    else {
      out.push(current);
      current = [];
    }
  }
  return out;
}

/** Runs the driver to its end; answers its exit code and how long it took. */
function runDriver(runtime: string, hc: string, file: string): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(runtime, [DRIVER], {
      stdio: "ignore",
      env: {
        ...process.env,
        HC_TERMINAL_ID: TERMINAL,
        COLLIE_HC_BIN: hc,
        DRIVER_RECORD: join(dir, "record.txt"),
        DRIVER_MARKER: join(dir, "marker.txt"),
        DRIVER_SESSION_FILE: file,
      },
    });
    const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolve({ code, ms: Date.now() - started });
    });
  });
}

const marker = () => (existsSync(join(dir, "marker.txt")) ? readFileSync(join(dir, "marker.txt"), "utf8") : "");

describe.skipIf(!POSIX)("a quit in a process of its own", () => {
  beforeEach(() => {
    delete process.env.PI_SESSION_ID;
    dir = mkdtempSync(join(tmpdir(), "pi-label-exit-"));
  });

  afterEach(() => {
    for (const pid of [...numbersIn(pidFile()), ...numbersIn(childFile())]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(runtimes())("with a quick hc the process ends after the quit, and the clear has landed (%s)", async (_runtime, bin) => {
    const file = join(dir, "sessions", "a.jsonl");
    const { code } = await runDriver(bin, writeHc(""), file);
    expect(code).toBe(0);
    expect(marker()).toBe("after-quit\n");
    expect(calls()).toEqual([
      ["label", TERMINAL, `pi.session_file=${file}`],
      ["label", TERMINAL, "pi.session_file="],
    ]);
  }, 20_000);

  const hangs: [string, string, string, string][] = runtimes().flatMap(([runtime, bin]) => [
    [runtime, bin, "a script that execs the sleep", "exec sleep 10"],
    [runtime, bin, "a wrapper script that leaves a child behind", `sleep 10 & echo $! >> "CHILDREN"; wait`],
  ]);
  test.each(hangs)("with an hc that hangs (%s, %s) the quit waits for the limit, then the process goes on and ends", async (_runtime, bin, _name, after) => {
    const file = join(dir, "sessions", "b.jsonl");
    const { code, ms } = await runDriver(bin, writeHc(after.replace("CHILDREN", childFile())), file);
    expect(code).toBe(0);
    // The line that went missing when the extension did not hold the loop.
    expect(marker()).toBe("after-quit\n");
    expect(ms).toBeGreaterThan(1200);
    expect(ms).toBeLessThan(6000);
    // The hc of the test is killed at the limit; the wrapper's own child may live on and is killed in cleanup.
    for (const pid of numbersIn(pidFile())) {
      for (let tries = 0; tries < 20 && alive(pid); tries += 1) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(alive(pid)).toBe(false);
    }
  }, 20_000);
});
