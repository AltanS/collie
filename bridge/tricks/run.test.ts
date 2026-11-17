import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostFor } from "../host.ts";
import { envPath, isBaseEnvName, neverReason, scrubEnv, scrubReason, WINDOWS_BASE_ENV_NAMES } from "./env.ts";
import { WINDOWS_KILL_TIMEOUT_MS, type KillSpawn } from "../tree-kill.ts";
import { BUN_BE_BUN, launchOf, outcomeProblem, runProgram, runtimeScript, shellArgv, STDERR_CAP_BYTES, windowsRunProblem, type RunChild, type RunSpec } from "./run.ts";
import { TRICKS_WINDOWS_SHELL_LINE } from "../../web/src/lib/tricks/schema.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-run-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** A script that prints the environment it got, one `NAME=value` per line, on every host. */
const PRINT_ENV_PROGRAM = 'process.stdout.write(Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`).join("\\n"));\n';

async function run(command: string, extra: Partial<RunSpec> = {}) {
  const cwd = await tempDir();
  return await runProgram({ command, cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "{}", ...extra });
}

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

describe("the env scrub", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/op",
    LANG: "C.UTF-8",
    SSH_AUTH_SOCK: "/run/user/1000/ssh",
    COLLIE_TOKEN: "abc",
    COLLIE_PORT: "8788",
    collie_lower: "x",
    OPENROUTER_API_KEY: KEY,
    GH_TOKEN: "ghp_x",
    AWS_SECRET_ACCESS_KEY: "y",
    DB_PASSWORD: "hunter2",
    SOME_NAME: KEY,
    HERDR_PLUGIN_CONFIG_DIR: "/home/op/.config/herdr/plugins/config/herdr.collie",
    POINTS_AT_CONFIG: "/home/op/.config/collie/.env",
    UNSET: undefined,
  };

  test("an allow-list: only the base names reach the program, never a COLLIE_ or HERDR_ name, a socket or a key", () => {
    expect(scrubEnv({ ...env, LC_ALL: "C", TERM: KEY })).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      LC_ALL: "C",
    });
  });

  test("a name the trick lists is passed as it is; a COLLIE_, HERDR_ or socket name never is, even listed", () => {
    expect(scrubEnv(env, ["GH_TOKEN", "SOME_NAME", "SSH_AUTH_SOCK", "COLLIE_TOKEN", "HERDR_PLUGIN_CONFIG_DIR", "NOT_SET"])).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      GH_TOKEN: "ghp_x",
      SOME_NAME: KEY,
    });
  });

  test("a TRICK_ test hook passes only with testHooks (trick dev, check --run), never in a bridge run, even listed", () => {
    const hooks = { ...env, TRICK_NOW: "1794225600", TRICK_TOOLS_ONLY_PATH: "1", trick_lower: "x" };
    expect(scrubEnv(hooks, ["TRICK_NOW"])).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/op", LANG: "C.UTF-8" });
    expect(scrubEnv(hooks, [], { testHooks: true })).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/op", LANG: "C.UTF-8", TRICK_NOW: "1794225600", TRICK_TOOLS_ONLY_PATH: "1" });
    expect(scrubReason("TRICK_NOW", "1", new Set(["TRICK_NOW"]))).toBe("a test hook, passed only by collie trick dev and check --run");
  });

  test("names why each one goes", () => {
    expect(scrubReason("COLLIE_TOKEN", "abc")).toBe("a COLLIE_ variable");
    expect(scrubReason("HERDR_PLUGIN_CONFIG_DIR", "/x")).toBe("a HERDR_ variable");
    expect(scrubReason("SSH_AUTH_SOCK", "/run/x", new Set(["SSH_AUTH_SOCK"]))).toBe("a socket");
    expect(scrubReason("DOCKER_SOCKET", "/run/x")).toBe("a socket");
    expect(scrubReason("OPENROUTER_API_KEY", KEY)).toBe("not on the allow-list; a trick lists it in env");
    expect(scrubReason("TERM", KEY)).toBe("a value the secret mask hides");
    expect(scrubReason("OPENROUTER_API_KEY", KEY, new Set(["OPENROUTER_API_KEY"]))).toBeNull();
    expect(scrubReason("PATH", "/usr/bin")).toBeNull();
  });

  test("a COLLIE_TOKEN and an OPENROUTER_API_KEY never reach the child", async () => {
    // The script form, so it runs on every host (a shell line does not run on Windows, fault d). The child is
    // a real Bun: on Windows it needs `SystemRoot`, which the scrub now keeps (fault a).
    const outcome = await script(await tempDir(), PRINT_ENV_PROGRAM, { stdin: "", env: scrubEnv({ ...process.env, COLLIE_TOKEN: "tok-must-not-leak", OPENROUTER_API_KEY: KEY }) });
    expect(outcome).toMatchObject({ kind: "exited", code: 0 });
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).not.toContain("COLLIE_TOKEN");
    expect(outcome.stdout).not.toContain("tok-must-not-leak");
    expect(outcome.stdout).not.toContain("OPENROUTER_API_KEY");
    expect(outcome.stdout).not.toContain(KEY.slice(4));
    // Windows spells it `Path`, and a name there is one in any case.
    expect(outcome.stdout.toUpperCase()).toContain("PATH=");
    // The SystemRoot line is a VM-only proof: the lead's Windows VM run is its proof.
    if (process.platform === "win32") expect(outcome.stdout.toUpperCase()).toContain("SYSTEMROOT=");
  });
});

describe("the env scrub on Windows (fault a): names without case, the copy's own spelling, never a secret", () => {
  const WIN = hostFor("win32");
  const LINUX = hostFor("linux");
  // A Windows environment copy, spelled the way Windows spells it, with secrets in odd case beside it.
  const winEnv = {
    Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd",
    PathExt: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    TEMP: "C:\\Users\\op\\AppData\\Local\\Temp",
    Tmp: "C:\\Users\\op\\AppData\\Local\\Temp",
    USERPROFILE: "C:\\Users\\op",
    APPDATA: "C:\\Users\\op\\AppData\\Roaming",
    LocalAppData: "C:\\Users\\op\\AppData\\Local",
    COLLIE_TOKEN: "tok-must-not-leak",
    collie_token: "tok-must-not-leak",
    Collie_Token: "tok-must-not-leak",
    Herdr_Plugin_Config_Dir: "C:\\x",
    ssh_auth_sock: "\\\\.\\pipe\\ssh",
    Docker_Socket: "\\\\.\\pipe\\docker",
    bun_be_bun: "1",
    trick_now: "1794225600",
    OpenRouter_Api_Key: KEY,
    gh_token: "ghp_x",
    Aws_Secret_Access_Key: "y",
    db_password: "hunter2",
    // A base name whose value the mask hides is dropped on Windows too.
    term: KEY,
  };
  const SECRET_VALUES = ["tok-must-not-leak", KEY, "ghp_x", "hunter2", "\\\\.\\pipe\\ssh", "\\\\.\\pipe\\docker"];

  test("keeps Path, PathExt, SystemRoot and the Windows base set, in the spelling the copy carries", () => {
    expect(scrubEnv(winEnv, [], { host: WIN })).toEqual({
      Path: winEnv.Path,
      PathExt: winEnv.PathExt,
      SystemRoot: winEnv.SystemRoot,
      windir: winEnv.windir,
      ComSpec: winEnv.ComSpec,
      TEMP: winEnv.TEMP,
      Tmp: winEnv.Tmp,
      USERPROFILE: winEnv.USERPROFILE,
      APPDATA: winEnv.APPDATA,
      LocalAppData: winEnv.LocalAppData,
    });
    for (const name of WINDOWS_BASE_ENV_NAMES) {
      expect(isBaseEnvName(name.toLowerCase(), WIN)).toBe(true);
      expect(isBaseEnvName(name, LINUX)).toBe(false);
    }
  });

  test("the Windows set and the folding stay off POSIX: Linux keeps the exact-case list it had", () => {
    expect(scrubEnv({ ...winEnv, PATH: "/usr/bin", LC_ALL: "C" }, [], { host: LINUX })).toEqual({ PATH: "/usr/bin", LC_ALL: "C" });
  });

  test("no secret-like name passes on either platform, in any case, listed or not", () => {
    // Every never-name, listed in its own odd case: a list cannot open them. The keys stay unlisted.
    const listedAll = ["COLLIE_TOKEN", "collie_token", "Collie_Token", "Herdr_Plugin_Config_Dir", "ssh_auth_sock", "Docker_Socket", "bun_be_bun", "trick_now"];
    for (const host of [WIN, LINUX]) {
      const out = scrubEnv(winEnv, listedAll, { host });
      const values = Object.values(out).join("\n");
      for (const secret of SECRET_VALUES) expect(values).not.toContain(secret);
      for (const name of Object.keys(out)) expect(name.toUpperCase()).not.toMatch(/^(COLLIE_|HERDR_)|_SOCK$|_SOCKET$|^BUN_BE_BUN$/);
    }
    // On POSIX a listed `trick_now` is another variable than the hook TRICK_NOW; on Windows it is the hook.
    expect(Object.keys(scrubEnv(winEnv, listedAll, { host: WIN })).map((n) => n.toUpperCase())).not.toContain("TRICK_NOW");
    // Listed by name, in another case, a COLLIE_ or socket name is still never passed.
    expect(scrubEnv(winEnv, ["COLLIE_TOKEN", "SSH_AUTH_SOCK", "BUN_BE_BUN", "TRICK_NOW"], { host: WIN })).not.toHaveProperty("collie_token");
    expect(neverReason("collie_token", WIN)).toBe("a COLLIE_ variable");
    expect(neverReason("Collie_Token", LINUX)).toBe("a COLLIE_ variable");
    // `trick_now` is TRICK_NOW on Windows: a test hook there, never passed in a bridge run even listed.
    expect(neverReason("trick_now", WIN)).toBe("a test hook, passed only by collie trick dev and check --run");
    expect(scrubEnv(winEnv, ["trick_now"], { host: WIN })).not.toHaveProperty("trick_now");
  });

  test("a key the trick lists passes on Windows in the copy's spelling, matched without case", () => {
    expect(scrubEnv(winEnv, ["GH_TOKEN"], { host: WIN })).toMatchObject({ gh_token: "ghp_x" });
    expect(scrubEnv(winEnv, ["GH_TOKEN"], { host: LINUX })).not.toHaveProperty("gh_token");
    expect(scrubReason("OpenRouter_Api_Key", KEY, new Set(), WIN)).toBe("not on the allow-list; a trick lists it in env");
    expect(scrubReason("term", KEY, new Set(), WIN)).toBe("a value the secret mask hides");
  });

  test("the PATH reader finds Path on a Windows copy and PATH only on POSIX", () => {
    expect(envPath(scrubEnv(winEnv, [], { host: WIN }), WIN)).toBe(winEnv.Path);
    expect(envPath({ Path: "C:\\x" }, LINUX)).toBeUndefined();
    expect(envPath({ PATH: "/usr/bin" }, LINUX)).toBe("/usr/bin");
  });
});

describe("one run", () => {
  // Each program here is a script Collie's own runtime runs (`run = "program.ts"`), not a shell line: the
  // caps, the mask and the kill are the runner's, the same for both forms, and a script runs on every
  // host, where a shell line is `sh` on POSIX and `cmd.exe` on Windows. A program ends by `exitCode`, not
  // `process.exit`, so what it wrote reaches the pipe first.

  test("stdin carries the facts, stdout comes back, cwd is the folder", async () => {
    const cwd = await tempDir();
    const outcome = await script(cwd, 'process.stdout.write(`${await Bun.stdin.text()} ${process.cwd()}`);\n', { stdin: '{"v":1}' });
    expect(outcome).toMatchObject({ kind: "exited", code: 0 });
    if (outcome.kind === "exited") expect(outcome.stdout).toBe(`{"v":1} ${cwd}`);
  });

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

  test("an abort kills the whole process group at once and ends the run stopped; an abort before the start starts nothing", async () => {
    const cwd = await tempDir();
    const pidFile = join(cwd, "child.pid");
    const program = [
      'import { writeFileSync } from "node:fs";',
      'const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "await Bun.sleep(30000);",
      "",
    ].join("\n");
    const stop = new AbortController();
    const running = script(cwd, program, { stdin: "", signal: stop.signal });
    for (let i = 0; i < 200 && !(await readFile(pidFile, "utf8").then((t) => t.trim() !== "", () => false)); i += 1) await Bun.sleep(25);
    const child = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(child)).toBe(true);
    const began = performance.now();
    stop.abort();
    const outcome = await running;
    expect(outcome.kind).toBe("stopped");
    expect(performance.now() - began).toBeLessThan(2000);
    for (let i = 0; i < 40 && alive(child); i += 1) await Bun.sleep(50);
    expect(alive(child)).toBe(false);
    expect(outcomeProblem(outcome, 200)).toBe("The program was stopped");

    const marker = join(cwd, "started");
    const before = await script(cwd, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`, { signal: stop.signal });
    expect(before.kind).toBe("stopped");
    expect(await Bun.file(marker).exists()).toBe(false);
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

  test("on Windows a timer that fires after the program exited (its pipe still held) kills no pid: no taskkill, only the orphan pass (a seam)", async () => {
    // The lead's review D, item 1: after the exit, Windows may have given the pid to a new process, and
    // `taskkill /PID <pid> /T /F` would end that process's whole tree. The state "exited, stdout still
    // held" comes from a stand-in child (`spawnChild`), not from a real grandchild: on Windows Bun does not
    // hand the pipe to a grandchild as POSIX does (VM run 2), so a real one could not build this state there.
    const calls: string[][] = [];
    const spawn: KillSpawn = (argv) => {
      calls.push(argv);
      return { exited: Promise.resolve(0) };
    };
    let kills = 0;
    const child = (): RunChild => {
      let closeOut = (): void => {};
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          closeOut = () => controller.close();
        },
        cancel() {},
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      let exitCode: number | null = null;
      // It exits at once; its stdout stays open until the runner lets go of it.
      const exited = Promise.resolve(0).then((code) => {
        exitCode = code;
        return code;
      });
      return {
        pid: 4242,
        stdin: { write: () => 0, end: () => 0 },
        stdout,
        stderr,
        get exitCode() {
          return exitCode;
        },
        exited,
        kill: () => {
          kills += 1;
          closeOut();
        },
      };
    };
    // The timer (50 ms) fires inside the pipe drain (PIPE_GRACE_MS, 250 ms) after the exit.
    const outcome = await runProgram({ command: "program.ts", cwd: await tempDir(), env: {}, stdin: "{}", timeoutMs: 50, platform: "win32", runtime: { execPath: "bun", compiled: false }, spawnChild: child, winKill: { spawn, env: { SystemRoot: "C:\\Windows" } } });
    await Bun.sleep(20);
    expect(outcome.kind).toBe("timeout");
    expect(calls.map((argv) => argv[0])).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
    expect(kills).toBe(0);
  });

  test("stdout past 64 KiB fails the run and stops the program", async () => {
    const started = performance.now();
    const outcome = await script(await tempDir(), 'const line = "a".repeat(1023) + "\\n";\nfor (;;) await new Promise((done) => process.stdout.write(line, done));\n');
    expect(outcome.kind).toBe("overflow");
    expect(performance.now() - started).toBeLessThan(5000);
    expect(outcomeProblem(outcome, 200)).toBe("The program printed more than 64 KiB and was stopped");
  });

  test("stderr is kept to 8 KiB and drained, so a chatty program does not block", async () => {
    const outcome = await script(await tempDir(), 'process.stderr.write("e".repeat(200000));\nprocess.stdout.write("done\\n");\n');
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).toBe("done\n");
    expect(outcome.stderr.length).toBe(STDERR_CAP_BYTES);
  });

  test("stdout and stderr go through the secret mask", async () => {
    const program = `process.stdout.write('{"face":"${KEY}"}\\n');\nprocess.stderr.write("curl failed for https://x/?key=${KEY}\\n");\nprocess.exitCode = 3;\n`;
    const outcome = await script(await tempDir(), program);
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).not.toContain(KEY);
    expect(outcome.stdout).toContain("sk-o•");
    expect(outcome.stderr).not.toContain(KEY);
    const line = outcomeProblem(outcome, 200);
    expect(line).toStartWith("The program exited with 3: curl failed");
    expect(line).not.toContain(KEY);
  });

  test("a background job that keeps stdout open does not hold the run", async () => {
    const started = performance.now();
    // The child inherits the program's stdout and outlives it by five seconds.
    const program = 'Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).unref();\nprocess.stdout.write("{}\\n");\n';
    const outcome = await script(await tempDir(), program);
    expect(outcome).toMatchObject({ kind: "exited", code: 0, stdout: "{}\n" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a folder that is not there is a spawn failure, not a throw", async () => {
    const outcome = await runProgram({ command: "true", cwd: "/nonexistent/collie-trick", env: {}, stdin: "" });
    expect(outcome.kind).toBe("spawn-failed");
    expect(outcomeProblem(outcome, 200)).toStartWith("The program did not start");
  });

  test("a clean exit is no problem", async () => {
    expect(outcomeProblem(await script(await tempDir(), 'process.stdout.write("{}");\n'), 200)).toBeNull();
  });
});

describe("the two forms of a run line", () => {
  const COMPILED = { execPath: "/opt/collie/bin/collie", compiled: true };
  const PLAIN = { execPath: "/usr/local/bin/bun", compiled: false };
  const ENV = { PATH: "/usr/bin:/bin", HOME: "/home/op" };

  test("a single script path in the folder is the script form; anything with shell words is not", () => {
    for (const ok of ["program.ts", "./program.ts", "src/main.mts", "a_b-c.1.js", "x.mjs"]) expect(runtimeScript(ok)).toBe(ok.replace(/^\.\//u, ""));
    for (const shell of ["./run.sh ./program.ts", "bun program.ts", "program.ts --flag", "/abs/program.ts", "../up.ts", ".hidden/x.ts", "x.ts;rm -rf", "x.py", "program.tsx", "'program.ts'", "a//b.ts", "a/../b.ts", ""]) {
      expect(runtimeScript(shell)).toBeNull();
    }
  });

  test("the script form runs Collie's own executable on the script, with BUN_BE_BUN only when it is compiled", () => {
    const compiled = launchOf("program.ts", ENV, { cwd: "/t/look", platform: "linux", runtime: COMPILED });
    // The script's path is joined by the host's own rule, with backslashes on Windows.
    expect(compiled.argv).toEqual(["/opt/collie/bin/collie", "--no-install", join("/t/look", "program.ts")]);
    expect(compiled.env).toEqual({ ...ENV, [BUN_BE_BUN]: "1" });
    const plain = launchOf("./program.ts", ENV, { cwd: "/t/look", platform: "linux", runtime: PLAIN });
    expect(plain.argv).toEqual(["/usr/local/bin/bun", "--no-install", join("/t/look", "program.ts")]);
    expect(plain.env).toEqual(ENV);
    expect(ENV).not.toHaveProperty(BUN_BE_BUN);
  });

  test("the shell form is unchanged, and never carries BUN_BE_BUN, not even under a compiled bridge", () => {
    for (const command of ["./run.sh ./program.ts", "./program.sh", "darius due --json"]) {
      const launch = launchOf(command, ENV, { cwd: "/t/look", platform: "linux", runtime: COMPILED });
      expect(launch.argv).toEqual(shellArgv(command, "linux"));
      expect(launch.env).toEqual(ENV);
    }
  });

  test("the scrub still applies: BUN_BE_BUN from the bridge's environment never passes, even listed", () => {
    expect(scrubReason(BUN_BE_BUN, "1", new Set([BUN_BE_BUN]))).toBe("Collie's own runtime switch");
    const scrubbed = scrubEnv({ ...ENV, BUN_BE_BUN: "1", COLLIE_TOKEN: "tok", OPENROUTER_API_KEY: KEY }, [BUN_BE_BUN]);
    expect(scrubbed).toEqual(ENV);
    expect(launchOf("./x.sh", scrubbed, { cwd: "/t", platform: "linux", runtime: COMPILED }).env).not.toHaveProperty(BUN_BE_BUN);
  });

  test("a script runs with the given runtime: the facts on stdin, the folder as cwd, the variable only when compiled", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "program.ts"), 'const facts = await Bun.stdin.text();\nconsole.log(JSON.stringify({ facts, cwd: process.cwd(), be: process.env.BUN_BE_BUN ?? null, token: process.env.COLLIE_TOKEN ?? null }));\n');
    const env = scrubEnv({ ...process.env, COLLIE_TOKEN: "tok-must-not-leak" });
    for (const compiled of [false, true]) {
      const outcome = await runProgram({ command: "program.ts", cwd, env, stdin: '{"v":1}', runtime: { execPath: process.execPath, compiled } });
      expect(outcome.kind).toBe("exited");
      if (outcome.kind !== "exited") return;
      expect(JSON.parse(outcome.stdout)).toEqual({ facts: '{"v":1}', cwd, be: compiled ? "1" : null, token: null });
    }
  });

  test("a shell run under a compiled bridge sees no BUN_BE_BUN", async () => {
    const outcome = await run("env", { env: scrubEnv({ ...process.env, BUN_BE_BUN: "1" }), runtime: COMPILED });
    // On Windows a shell line does not run at all (fault d): the one sentence, nothing started.
    if (process.platform === "win32") {
      expect(outcome).toEqual({ kind: "spawn-failed", message: TRICKS_WINDOWS_SHELL_LINE, ms: 0 });
      return;
    }
    expect(outcome).toMatchObject({ kind: "exited", code: 0 });
    if (outcome.kind === "exited") expect(outcome.stdout).not.toContain("BUN_BE_BUN");
  });
});

describe("a shell run line on Windows (fault d)", () => {
  test("the rule: on win32 only the script form runs; a shell line gets the one sentence; POSIX and no run line are never refused", () => {
    for (const line of ["./legs.sh", "bun program.ts", "darius due --json", 'echo "{}"', "program.sh", "cmd /c x.bat"]) expect(windowsRunProblem(line, "win32")).toBe(TRICKS_WINDOWS_SHELL_LINE);
    for (const line of ["program.ts", "./program.ts", "lib/main.mjs", "x.js", "x.mts"]) expect(windowsRunProblem(line, "win32")).toBeNull();
    expect(windowsRunProblem(undefined, "win32")).toBeNull();
    expect(windowsRunProblem("./legs.sh", "linux")).toBeNull();
    expect(windowsRunProblem("./legs.sh", "darwin")).toBeNull();
    expect(windowsRunProblem("./legs.sh", undefined)).toBeNull();
  });

  test("the runner never starts a shell line on win32: no cmd.exe, the sentence as a spawn failure", async () => {
    const cwd = await tempDir();
    const marker = join(cwd, "ran");
    const outcome = await runProgram({ command: `echo x > ${marker}`, cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "{}", platform: "win32" });
    expect(outcome).toEqual({ kind: "spawn-failed", message: TRICKS_WINDOWS_SHELL_LINE, ms: 0 });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
