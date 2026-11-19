// The slow cases of run.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS_KILL_TIMEOUT_MS, type KillSpawn } from "../tree-kill.ts";
import { outcomeProblem, runProgram, type RunSpec } from "./run.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-run-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Run `program` as the trick's `program.ts` in `cwd`, with the Bun that runs the tests. */
async function script(cwd: string, program: string, extra: Partial<RunSpec> = {}) {
  await writeFile(join(cwd, "program.ts"), program);
  return await runProgram({ command: "program.ts", cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "{}", runtime: { execPath: process.execPath, compiled: false }, ...extra });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("one run", () => {
  test("the timeout kills the whole process group", async () => {
    const cwd = await tempDir();
    const pidFile = join(cwd, "child.pid");
    // A child of the program's own, as `sh -c` starting `curl` would have: the kill must reach it too.
    const program = [
      'import { writeFileSync } from "node:fs";',
      'const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "await Bun.sleep(30000);",
      "",
    ].join("\n");
    // Long enough for the program and its child to start on a slow host before the kill.
    const outcome = await script(cwd, program, { stdin: "", timeoutMs: 2000 });
    expect(outcome.kind).toBe("timeout");
    const child = Number((await readFile(pidFile, "utf8")).trim());
    for (let i = 0; i < 40 && alive(child); i += 1) await Bun.sleep(50);
    expect(alive(child)).toBe(false);
    expect(outcomeProblem(outcome, 200)).toBe("The program ran past 2 s and was stopped");
  });

  test("the timeout reaches a grandchild under a live child (on Windows: taskkill /T over the live tree)", async () => {
    const cwd = await tempDir();
    const pidFile = join(cwd, "grandchild.pid");
    // program -> middle (alive, sleeping) -> grandchild. POSIX kills the group; Windows walks the tree.
    // A VM-only proof for Windows: on Linux the group kill answers; the lead's Windows VM run is its proof there.
    const middle = `const g = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); await Bun.sleep(30000);`;
    const program = [`Bun.spawn([process.execPath, "-e", ${JSON.stringify(middle)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`, "await Bun.sleep(30000);", ""].join("\n");
    const outcome = await script(cwd, program, { stdin: "", timeoutMs: 3000 });
    expect(outcome.kind).toBe("timeout");
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    for (let i = 0; i < 100 && alive(grandchild); i += 1) await Bun.sleep(50);
    expect(alive(grandchild)).toBe(false);
  });

  test("a taskkill the trick ships in its folder never runs at the timeout", async () => {
    const cwd = await tempDir();
    const marker = join(cwd, "planted-ran");
    // A bare `taskkill` would find these first in the run's cwd on Windows. The real kill must not.
    // A VM-only proof: Linux never runs taskkill, so this passes there by itself. The lead's Windows VM run is its proof.
    await writeFile(join(cwd, "taskkill.cmd"), `@echo off\r\necho ran> "${marker}"\r\n`);
    await writeFile(join(cwd, "taskkill.bat"), `@echo off\r\necho ran> "${marker}"\r\n`);
    const outcome = await script(cwd, "await Bun.sleep(30000);\n", { stdin: "", timeoutMs: 1500 });
    expect(outcome.kind).toBe("timeout");
    await Bun.sleep(500);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("on Windows the timeout kill is the absolute taskkill, as argv, with a time limit, then the program, then the orphan pass (a seam)", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "taskkill.exe"), "MZ planted");
    await writeFile(join(cwd, "taskkill.cmd"), "@echo planted\r\n");
    const calls: { argv: string[]; timeoutMs: number }[] = [];
    const spawn: KillSpawn = (argv, opts) => {
      calls.push({ argv, timeoutMs: opts.timeoutMs });
      return { exited: Promise.resolve(0) };
    };
    // The program's own env names a SystemRoot in the trick folder: the kill never reads it.
    const outcome = await script(cwd, "await Bun.sleep(30000);\n", {
      stdin: "",
      timeoutMs: 1000,
      platform: "win32",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SystemRoot: cwd },
      winKill: { spawn, env: { SystemRoot: "D:\\WINNT" } },
    });
    // The fake taskkill kills nothing; the program itself is ended right after it (the leader).
    expect(outcome.kind).toBe("timeout");
    await Bun.sleep(50);
    expect(calls).toHaveLength(2);
    const [taskkill, orphans] = calls;
    expect(taskkill?.argv[0]).toBe("D:\\WINNT\\System32\\taskkill.exe");
    expect(taskkill?.argv.slice(1, 2)).toEqual(["/PID"]);
    expect(taskkill?.argv.slice(3)).toEqual(["/T", "/F"]);
    const pid = taskkill?.argv[2] ?? "";
    expect(pid).toMatch(/^\d+$/);
    expect(orphans?.argv[0]).toBe("D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(orphans?.argv[4]).toContain(`$queue.Enqueue(@(${pid}, $from, $to))`);
    for (const call of calls) {
      expect(call.timeoutMs).toBe(WINDOWS_KILL_TIMEOUT_MS);
      expect(call.argv[0]?.startsWith(cwd)).toBe(false);
      expect(call.argv[0]).not.toBe("taskkill");
    }
    // With no seam env, SystemRoot comes from the bridge's own environment, never the program's.
    const fallback: string[][] = [];
    await script(await tempDir(), "await Bun.sleep(30000);\n", {
      stdin: "",
      timeoutMs: 500,
      platform: "win32",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SystemRoot: cwd },
      winKill: { spawn: (argv) => (fallback.push(argv), { exited: Promise.resolve(0) }) },
    });
    await Bun.sleep(50);
    expect(fallback[0]?.[0]).toBe(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`);
  });
});
