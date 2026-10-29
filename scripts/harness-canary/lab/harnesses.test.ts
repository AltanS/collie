import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_SETTINGS, codexConfig, codexTrust, HARNESSES, harnessSpec, npmInstallCommand, OPENCODE_ASK_FILE, runDirs, TURN_CAP } from "./harnesses";
import { REPLY_ROW } from "./legs";
import { prepareRun } from "./seed";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lab-harnesses-"));
  roots.push(dir);
  return dir;
};

/** A Codex API key login and an OpenRouter key, in files of a scratch home, for the specs that sign in. */
function sources() {
  const dir = temp();
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-real" }));
  return { codexSource: { authFile }, env: { OPENROUTER_API_KEY: "sk-or-v1-test-not-real" } };
}

describe("the harness table", () => {
  test("Codex, OpenCode and omp make the send and the ask turns, and Claude keeps its cap", () => {
    for (const id of ["claude", "codex", "opencode", "omp"]) expect(harnessSpec(id).turnCap).toBe(TURN_CAP);
  });

  test("a harness whose env names a folder has that folder made before its first start (the 2026-10-17 Codex failure)", () => {
    const dirs = runDirs(join(temp(), "codex-0.163.0"));
    const spec = harnessSpec("codex");
    // Codex 0.163.0 prints "CODEX_HOME points to ..., but that path does not exist" and exits with status 1.
    expect(existsSync(spec.env(dirs).CODEX_HOME ?? "")).toBe(false);
    prepareRun(spec, dirs, sources());
    expect(existsSync(spec.env(dirs).CODEX_HOME ?? "")).toBe(true);
  });

  test("a Codex run copies the API key login and trusts its one project folder, so no trust question comes first", () => {
    const dirs = runDirs(join(temp(), "codex-0.163.0"));
    prepareRun(harnessSpec("codex"), dirs, sources());
    const home = harnessSpec("codex").env(dirs).CODEX_HOME ?? "";
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).OPENAI_API_KEY).toBe("sk-test-not-real");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(codexConfig(dirs.project));
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(codexTrust(dirs.project));
  });

  test("the Codex trust file is a TOML table named by the project path, with the path escaped", () => {
    expect(codexTrust("/lab/project")).toBe('[projects."/lab/project"]\ntrust_level = "trusted"\n');
    expect(codexTrust('/odd "dir"/project')).toContain('[projects."/odd \\"dir\\"/project"]');
  });

  test("Codex starts so that a shell command asks first, with the person as reviewer, and with no update prompt", () => {
    const args = harnessSpec("codex").startArgs(runDirs("/run"));
    expect(args.join(" ")).toContain("-a on-request -s read-only");
    expect(CODEX_SETTINGS).toContain('approvals_reviewer = "user"');
    expect(CODEX_SETTINGS).toContain("check_for_update_on_startup = false");
    expect(CODEX_SETTINGS).toContain('model_reasoning_effort = "low"');
  });

  test("Codex starts with no -c override: from 0.166.0 any -c draws a warning row in the footer (harness lab drift, 2026-10-29)", () => {
    const args = harnessSpec("codex").startArgs(runDirs("/run"));
    expect(args).not.toContain("-c");
    expect(args.some((arg) => arg.includes("="))).toBe(false);
  });

  test("the Codex settings are top-level keys, before the trust table, so TOML does not read them into it", () => {
    const config = codexConfig("/lab/project");
    expect(config.startsWith(CODEX_SETTINGS)).toBe(true);
    expect(config.indexOf("[projects.")).toBeGreaterThan(config.indexOf("approvals_reviewer"));
  });

  test("OpenCode starts with a scratch config that asks before bash and edit, written into the run folder", () => {
    const dirs = runDirs(join(temp(), "opencode-1.19.3"));
    const spec = harnessSpec("opencode");
    prepareRun(spec, dirs, sources());
    const file = spec.env(dirs).OPENCODE_CONFIG ?? "";
    expect(file).toBe(join(dirs.root, OPENCODE_ASK_FILE));
    expect(JSON.parse(readFileSync(file, "utf8")).permission).toEqual({ bash: "ask", edit: "ask" });
    expect(spec.login).toBe("none");
  });

  test("omp skips the setup questions and the update check, asks before every tool, and names its model", () => {
    const dirs = runDirs(join(temp(), "omp-18.12.1"));
    const spec = harnessSpec("omp");
    prepareRun(spec, dirs, sources());
    const config = readFileSync(join(spec.env(dirs).HOME ?? "", ".omp", "agent", "config.yml"), "utf8");
    expect(config).toContain("setupVersion: 2");
    expect(config).toContain("checkUpdate: false");
    expect(spec.startArgs(dirs).join(" ")).toContain("--approval-mode always-ask");
    expect(spec.startArgs(dirs)).toContain("--model");
  });

  test("the OpenRouter key never sits in a file of the run or on the command line", () => {
    const dirs = runDirs(join(temp(), "omp-18.12.1"));
    const spec = harnessSpec("omp");
    prepareRun(spec, dirs, sources());
    for (const text of [...Object.values(spec.files(dirs)), ...spec.startArgs(dirs), ...Object.values(spec.env(dirs))]) expect(text).not.toContain("sk-or-v1");
  });

  test("each harness presses the option that declines in its own words", () => {
    const declines = (id: string, label: string): boolean => harnessSpec(id).decline.test(label);
    expect(declines("claude", "No")).toBe(true);
    expect(declines("codex", "No, and tell Codex what to do differently")).toBe(true);
    expect(declines("codex", "Yes, proceed")).toBe(false);
    expect(declines("opencode", "Reject")).toBe(true);
    expect(declines("opencode", "Allow once")).toBe(false);
    expect(declines("opencode", "Allow always")).toBe(false);
    expect(declines("omp", "Deny")).toBe(true);
    expect(declines("omp", "Approve")).toBe(false);
    expect(declines("omp", "Cancel")).toBe(false);
  });

  test("every spec in the table is found by its own id", () => {
    for (const [id, spec] of Object.entries(HARNESSES)) expect(spec?.id).toBe(id);
  });
});

describe("the npm install", () => {
  const dirs = runDirs("/tmp/lab-run/opencode-1.19.5");
  const command = npmInstallCommand(harnessSpec("opencode"), dirs, "1.19.5", { HOME: "/home/x", npm_config_fund: "false" });

  test("it installs the exact version under the run's own prefix", () => {
    expect(command.argv).toEqual(["npm", "install", "--prefix", dirs.bin, "--no-audit", "--no-fund", "--no-save", "opencode-ai@1.19.5"]);
  });

  test("it sets min-release-age to 0 in the environment of that call and keeps the rest", () => {
    expect(command.env.npm_config_min_release_age).toBe("0");
    expect(command.env).toMatchObject({ HOME: "/home/x", npm_config_fund: "false" });
  });

  test("it writes no config file and takes no config flag, so the person's ~/.npmrc stays as it is", () => {
    expect(command.argv.some((arg) => arg.startsWith("--userconfig") || arg.startsWith("--globalconfig") || arg.includes("min-release-age"))).toBe(false);
  });
});

describe("the reply row", () => {
  test("it matches the reply of each harness as the screens draw it: a bullet or none", () => {
    for (const row of ["● OK", "• OK", " OK", "     OK", "  OK."]) expect(REPLY_ROW.test(row)).toBe(true);
  });

  test("it does not match the message that was typed, the composer or a longer word", () => {
    for (const row of ["› Reply with only the word OK.", "  ┃  Reply with only the word OK.", "> Ask Codex to do anything", "● OKAY", "Worked for 1s"]) expect(REPLY_ROW.test(row)).toBe(false);
  });
});
