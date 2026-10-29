import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessSpec, runDirs } from "./harnesses";
import { codexLoginText, LabDeferred, loginEnv, openrouterKey, prepareRun, REPLAY_TOKEN, replayLogin, runState, seedClaude, seedClaudeReplay, seedCodex, withoutRefresh, type SeedSource } from "./seed";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lab-seed-"));
  dirs.push(dir);
  return dir;
};

const login = (minutes: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: "access-token-value", refreshToken: "refresh-token-value", expiresAt: Date.now() + minutes * 60_000, scopes: ["a"], subscriptionType: "max" } });

function source(minutes: number): SeedSource {
  const configDir = temp();
  writeFileSync(join(configDir, ".credentials.json"), login(minutes));
  const stateFile = join(configDir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, projects: { "/secret/project": { history: ["x"] } }, numStartups: 4, theme: "dark" }));
  return { configDir, stateFile };
}

describe("the Claude login copy", () => {
  test("the copy has no refresh token, so a refresh in the lab can never rotate the real one", () => {
    const { text } = withoutRefresh(login(60));
    expect(text).not.toContain("refresh");
    expect(JSON.parse(text).claudeAiOauth.accessToken).toBe("access-token-value");
  });

  test("a token with less than 25 minutes left defers the run and writes nothing", () => {
    const target = join(temp(), "config");
    expect(() => seedClaude(target, "/p", source(16))).toThrow(LabDeferred);
    expect(existsSync(target)).toBe(false);
  });

  test("a token with enough time is copied into the run folder, with no refresh token and an empty MCP config", () => {
    const target = join(temp(), "config");
    const minutes = seedClaude(target, "/p", source(60));
    expect(minutes).toBeGreaterThan(55);
    expect(readFileSync(join(target, ".credentials.json"), "utf8")).not.toContain("refresh");
    expect(JSON.parse(readFileSync(join(target, "empty-mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  });

  // POSIX only: Windows has no file modes, so statSync reports 0o666 there. The skip is named in
  // scripts/windows-suites.ps1 (scripts budget).
  test.skipIf(process.platform === "win32")("POSIX only: the login copy has mode 600", () => {
    const target = join(temp(), "config");
    seedClaude(target, "/p", source(60));
    expect(statSync(join(target, ".credentials.json")).mode & 0o777).toBe(0o600);
  });

  test("a missing login defers the run", () => {
    const empty = temp();
    expect(() => seedClaude(join(temp(), "config"), "/p", { configDir: empty, stateFile: join(empty, "none.json") })).toThrow(/no Claude login/);
  });

  test("the state copy keeps the account, drops the project history, trusts the one project and skips the renderer question", () => {
    const state = JSON.parse(runState(readFileSync(source(60).stateFile, "utf8"), "/lab/project"));
    expect(state.oauthAccount.emailAddress).toBe("me@example.com");
    expect(Object.keys(state.projects)).toEqual(["/lab/project"]);
    expect(state.projects["/lab/project"].hasTrustDialogAccepted).toBe(true);
    expect(state.fullscreenUpsellSeenCount).toBe(3);
    expect(state.theme).toBeUndefined();
  });
});

describe("the replayed Claude's login (M67 spec 07)", () => {
  test("keeps the plan and scopes, never the access or refresh token, and lasts a day", () => {
    const now = 1_000_000;
    const parsed = JSON.parse(replayLogin(login(60), now)).claudeAiOauth;
    expect(parsed).toEqual({ scopes: ["a"], subscriptionType: "max", accessToken: REPLAY_TOKEN, expiresAt: now + 86_400_000 });
    expect(replayLogin(login(60))).not.toMatch(/access-token-value|refresh/u);
  });

  test("needs no real login: with none it writes a Max login with the inference scope", () => {
    expect(JSON.parse(replayLogin(null, 0)).claudeAiOauth).toEqual({ scopes: ["user:inference"], subscriptionType: "max", accessToken: REPLAY_TOKEN, expiresAt: 86_400_000 });
    const empty = temp();
    const target = join(temp(), "config");
    seedClaudeReplay(target, "/p", { configDir: empty, stateFile: join(empty, "none.json") });
    expect(JSON.parse(readFileSync(join(target, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe(REPLAY_TOKEN);
    expect(JSON.parse(readFileSync(join(target, ".claude.json"), "utf8")).projects["/p"].hasTrustDialogAccepted).toBe(true);
  });

  test("ignores the 25-minute rule: an expiring real login still seeds a replay", () => {
    const target = join(temp(), "config");
    seedClaudeReplay(target, "/p", source(1));
    expect(readFileSync(join(target, ".credentials.json"), "utf8")).not.toContain("access-token-value");
  });
});

const apiKeyLogin = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-real" });
const chatgptLogin = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "i", access_token: "a", refresh_token: "r" } });

function codexSource(text: string | null) {
  const authFile = join(temp(), "auth.json");
  if (text !== null) writeFileSync(authFile, text);
  return { authFile };
}

describe("the Codex login copy", () => {
  test("an API key login is copied as it is", () => {
    expect(codexLoginText(apiKeyLogin)).toBe(apiKeyLogin);
  });

  test("a ChatGPT login is refused, because a refresh in the lab would turn the real refresh token over", () => {
    expect(() => codexLoginText(chatgptLogin)).toThrow(LabDeferred);
    expect(() => codexLoginText(chatgptLogin)).toThrow(/refresh token/);
  });

  test("a login file that holds a token beside a key is refused too", () => {
    expect(() => codexLoginText(JSON.stringify({ OPENAI_API_KEY: "sk-test-not-real", tokens: { refresh_token: "r" } }))).toThrow(LabDeferred);
  });

  test("a file that is not JSON, an empty key and a missing file defer the run", () => {
    expect(() => codexLoginText("not json")).toThrow(LabDeferred);
    expect(() => codexLoginText(JSON.stringify({ OPENAI_API_KEY: "" }))).toThrow(LabDeferred);
    expect(() => seedCodex(join(temp(), "home"), codexSource(null))).toThrow(/no Codex login/);
  });

  test("the copy lands in CODEX_HOME, and a refused login writes nothing", () => {
    const home = join(temp(), "home");
    expect(() => seedCodex(home, codexSource(chatgptLogin))).toThrow(LabDeferred);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    seedCodex(home, codexSource(apiKeyLogin));
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(apiKeyLogin);
    // POSIX only, as an inline check: Windows has no file modes, and a new skip would break its budget.
    if (process.platform !== "win32") expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("the OpenRouter key of an omp run", () => {
  const dotenv = (text: string): string => {
    const file = join(temp(), ".env");
    writeFileSync(file, text);
    return file;
  };

  test("the lab's own environment wins", () => {
    expect(openrouterKey({ OPENROUTER_API_KEY: "sk-or-v1-from-env", COLLIE_RIG_KEY_FILE: dotenv("OPENROUTER_API_KEY=sk-or-v1-from-file\n") })).toBe("sk-or-v1-from-env");
  });

  test("the dotenv file named by COLLIE_RIG_KEY_FILE gives the key, with or without export and quotes", () => {
    expect(openrouterKey({ COLLIE_RIG_KEY_FILE: dotenv("OTHER=1\nOPENROUTER_API_KEY=sk-or-v1-plain\n") })).toBe("sk-or-v1-plain");
    expect(openrouterKey({ COLLIE_RIG_KEY_FILE: dotenv('export OPENROUTER_API_KEY="sk-or-v1-quoted"\n') })).toBe("sk-or-v1-quoted");
  });

  test("no key, a missing file and a file without the name each defer the run", () => {
    expect(() => openrouterKey({})).toThrow(LabDeferred);
    expect(() => openrouterKey({ COLLIE_RIG_KEY_FILE: join(temp(), "nope") })).toThrow(/does not exist/);
    expect(() => openrouterKey({ COLLIE_RIG_KEY_FILE: dotenv("OTHER=1\n") })).toThrow(/no OPENROUTER_API_KEY/);
  });

  test("only an omp run signs in through the environment", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-v1-from-env" };
    expect(loginEnv(harnessSpec("omp"), env)).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-from-env" });
    for (const id of ["claude", "codex", "opencode", "pi"]) expect(loginEnv(harnessSpec(id), env)).toEqual({});
  });
});

describe("prepareRun", () => {
  test("a run that cannot sign in defers before anything is spent", () => {
    const run = runDirs(join(temp(), "codex-0.163.0"));
    expect(() => prepareRun(harnessSpec("codex"), run, { codexSource: codexSource(null) })).toThrow(LabDeferred);
    expect(() => prepareRun(harnessSpec("omp"), runDirs(join(temp(), "omp-18.12.1")), { env: {} })).toThrow(LabDeferred);
  });

  test("a harness with no login and no folder needs nothing", () => {
    expect(() => prepareRun(harnessSpec("pi"), runDirs(join(temp(), "pi-1.3.0")))).not.toThrow();
  });
});
