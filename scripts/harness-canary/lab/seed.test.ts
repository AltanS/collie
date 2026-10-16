import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabDeferred, runState, seedClaude, withoutRefresh, type SeedSource } from "./seed";

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
