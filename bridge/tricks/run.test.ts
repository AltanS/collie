import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubEnv, scrubReason } from "./env.ts";
import { BUN_BE_BUN, launchOf, outcomeProblem, runProvider, runtimeScript, shellArgv, STDERR_CAP_BYTES, type RunSpec } from "./run.ts";

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

async function run(command: string, extra: Partial<RunSpec> = {}) {
  const cwd = await tempDir();
  return await runProvider({ command, cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "{}", ...extra });
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
    const outcome = await run("env", { env: scrubEnv({ ...process.env, COLLIE_TOKEN: "tok-must-not-leak", OPENROUTER_API_KEY: KEY }) });
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).not.toContain("COLLIE_TOKEN");
    expect(outcome.stdout).not.toContain("tok-must-not-leak");
    expect(outcome.stdout).not.toContain("OPENROUTER_API_KEY");
    expect(outcome.stdout).not.toContain(KEY.slice(4));
    expect(outcome.stdout).toContain("PATH=");
  });
});

describe("one run", () => {
  test("stdin carries the facts, stdout comes back, cwd is the folder", async () => {
    const cwd = await tempDir();
    const outcome = await runProvider({ command: 'cat; printf " %s" "$(pwd)"', cwd, env: { PATH: process.env.PATH ?? "" }, stdin: '{"v":1}' });
    expect(outcome).toMatchObject({ kind: "exited", code: 0 });
    if (outcome.kind === "exited") expect(outcome.stdout).toBe(`{"v":1} ${cwd}`);
  });

  test("the timeout kills the whole process group", async () => {
    const cwd = await tempDir();
    const pidFile = join(cwd, "child.pid");
    const outcome = await runProvider({
      command: `sleep 30 & echo $! > "${pidFile}"; sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      stdin: "",
      timeoutMs: 300,
    });
    expect(outcome.kind).toBe("timeout");
    const child = Number((await readFile(pidFile, "utf8")).trim());
    await Bun.sleep(100);
    expect(alive(child)).toBe(false);
    expect(outcomeProblem(outcome, 200)).toBe("The provider ran past 0 s and was stopped");
  });

  test("stdout past 64 KiB fails the run and stops the provider", async () => {
    const started = performance.now();
    const outcome = await run("yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(outcome.kind).toBe("overflow");
    expect(performance.now() - started).toBeLessThan(5000);
    expect(outcomeProblem(outcome, 200)).toBe("The provider printed more than 64 KiB and was stopped");
  });

  test("stderr is kept to 8 KiB and drained, so a chatty provider does not block", async () => {
    const outcome = await run("head -c 200000 /dev/zero | tr '\\0' e >&2; echo done");
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).toBe("done\n");
    expect(outcome.stderr.length).toBe(STDERR_CAP_BYTES);
  });

  test("stdout and stderr go through the secret mask", async () => {
    const outcome = await run(`echo '{"face":"${KEY}"}'; echo "curl failed for https://x/?key=${KEY}" >&2; exit 3`);
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.stdout).not.toContain(KEY);
    expect(outcome.stdout).toContain("sk-o•");
    expect(outcome.stderr).not.toContain(KEY);
    const line = outcomeProblem(outcome, 200);
    expect(line).toStartWith("The provider exited with 3: curl failed");
    expect(line).not.toContain(KEY);
  });

  test("a background job that keeps stdout open does not hold the run", async () => {
    const started = performance.now();
    const outcome = await run("sleep 5 & echo '{}'");
    expect(outcome).toMatchObject({ kind: "exited", code: 0, stdout: "{}\n" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a folder that is not there is a spawn failure, not a throw", async () => {
    const outcome = await runProvider({ command: "true", cwd: "/nonexistent/collie-trick", env: {}, stdin: "" });
    expect(outcome.kind).toBe("spawn-failed");
    expect(outcomeProblem(outcome, 200)).toStartWith("The provider did not start");
  });

  test("a clean exit is no problem", async () => {
    expect(outcomeProblem(await run("echo '{}'"), 200)).toBeNull();
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
    expect(compiled.argv).toEqual(["/opt/collie/bin/collie", "--no-install", "/t/look/program.ts"]);
    expect(compiled.env).toEqual({ ...ENV, [BUN_BE_BUN]: "1" });
    const plain = launchOf("./program.ts", ENV, { cwd: "/t/look", platform: "linux", runtime: PLAIN });
    expect(plain.argv).toEqual(["/usr/local/bin/bun", "--no-install", "/t/look/program.ts"]);
    expect(plain.env).toEqual(ENV);
    expect(ENV).not.toHaveProperty(BUN_BE_BUN);
  });

  test("the shell form is unchanged, and never carries BUN_BE_BUN, not even under a compiled bridge", () => {
    for (const command of ["./run.sh ./program.ts", "./provider.sh", "darius due --json"]) {
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
      const outcome = await runProvider({ command: "program.ts", cwd, env, stdin: '{"v":1}', runtime: { execPath: process.execPath, compiled } });
      expect(outcome.kind).toBe("exited");
      if (outcome.kind !== "exited") return;
      expect(JSON.parse(outcome.stdout)).toEqual({ facts: '{"v":1}', cwd, be: compiled ? "1" : null, token: null });
    }
  });

  test("a shell run under a compiled bridge sees no BUN_BE_BUN", async () => {
    const outcome = await run("env", { env: scrubEnv({ ...process.env, BUN_BE_BUN: "1" }), runtime: COMPILED });
    expect(outcome.kind).toBe("exited");
    if (outcome.kind === "exited") expect(outcome.stdout).not.toContain("BUN_BE_BUN");
  });
});
