import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubEnv, scrubReason } from "./env.ts";
import { outcomeProblem, runProvider, STDERR_CAP_BYTES, type RunSpec } from "./run.ts";

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

  test("drops every COLLIE_ variable, every secret name, a masked value and the config folder", () => {
    expect(scrubEnv(env, "/home/op/.config/collie")).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      SSH_AUTH_SOCK: "/run/user/1000/ssh",
    });
  });

  test("names why each one goes", () => {
    expect(scrubReason("COLLIE_TOKEN", "abc")).toBe("a COLLIE_ variable");
    expect(scrubReason("OPENROUTER_API_KEY", KEY)).toBe("a name that says secret");
    expect(scrubReason("SOME_NAME", KEY)).toBe("a value the secret mask hides");
    expect(scrubReason("X", "/c/.env", "/c")).toBe("names the config folder");
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
