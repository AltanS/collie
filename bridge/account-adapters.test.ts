import { describe, expect, test } from "bun:test";

import { ACCOUNT_ADAPTERS, ACCOUNT_HARNESSES, accountAdapter } from "./account-adapters.ts";
import { accountTest } from "./accounts-skip.ts";
import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject } from "./json.ts";

describe("the account adapter table", () => {
  test("every key is a launch id", () => {
    for (const id of ACCOUNT_HARNESSES) expect(harnessLaunch(id), id).toBeDefined();
  });

  test("claude, codex, pi and grok, in that order", () => {
    expect(ACCOUNT_HARNESSES).toEqual(["claude", "codex", "pi", "grok"]);
  });

  test("an inherited key is no adapter", () => {
    expect(accountAdapter("toString")).toBeUndefined();
    expect(accountAdapter("__proto__")).toBeUndefined();
    expect(accountAdapter("omp")).toBeUndefined();
  });

  accountTest("the default folder follows the agent's own variable, and only an absolute one", () => {
    const home = "/home/op";
    expect(ACCOUNT_ADAPTERS.claude.defaultDir(home, {})).toBe("/home/op/.claude");
    expect(ACCOUNT_ADAPTERS.claude.defaultDir(home, { CLAUDE_CONFIG_DIR: "/srv/c/" })).toBe("/srv/c");
    expect(ACCOUNT_ADAPTERS.claude.defaultDir(home, { CLAUDE_CONFIG_DIR: "rel" })).toBe("/home/op/.claude");
    expect(ACCOUNT_ADAPTERS.codex.defaultDir(home, {})).toBe("/home/op/.codex");
    expect(ACCOUNT_ADAPTERS.pi.defaultDir(home, {})).toBe("/home/op/.pi/agent");
    expect(ACCOUNT_ADAPTERS.grok.defaultDir(home, {})).toBe("/home/op/.grok");
    expect(ACCOUNT_ADAPTERS.grok.defaultDir(home, { GROK_HOME: "/srv/g/" })).toBe("/srv/g");
  });

  accountTest("the journal root sits where bridge/config.ts puts the default one", () => {
    expect(ACCOUNT_ADAPTERS.claude.journalRoot("/a")).toBe("/a/projects");
    expect(ACCOUNT_ADAPTERS.codex.journalRoot("/a")).toBe("/a/sessions");
    expect(ACCOUNT_ADAPTERS.pi.journalRoot("/a")).toBe("/a/sessions");
    expect(ACCOUNT_ADAPTERS.grok.journalRoot("/a")).toBe("/a/sessions");
  });

  test("only Claude shares, and it never links a login or the per-account state", () => {
    expect("share" in ACCOUNT_ADAPTERS.codex).toBe(false);
    expect("share" in ACCOUNT_ADAPTERS.pi).toBe(false);
    expect("share" in ACCOUNT_ADAPTERS.grok).toBe(false);
    const share = ACCOUNT_ADAPTERS.claude.share;
    const all: string[] = [...share.dirs, ...share.files];
    for (const own of [".credentials.json", ".claude.json", "backups", "statsig", "sessions", "daemon", "jobs"]) expect(all).not.toContain(own);
  });

  test("a new folder is named from the slug", () => {
    expect(ACCOUNT_ADAPTERS.claude.newDirName("work")).toBe(".claude-work");
    expect(ACCOUNT_ADAPTERS.claude.newFolder).toBe("~/.claude-{slug}");
    expect(ACCOUNT_ADAPTERS.grok.newDirName("work")).toBe(".grok-work");
  });

  test("Grok: its folder is told by the entry names its first start writes", () => {
    expect(ACCOUNT_ADAPTERS.grok.select).toEqual({ env: "GROK_HOME" });
    expect(ACCOUNT_ADAPTERS.grok.nameGlobs).toEqual(["~/.grok-*"]);
    expect(ACCOUNT_ADAPTERS.grok.looksLike(["agent_id", "config.toml", "sessions", "logs"])).toBe(true);
    expect(ACCOUNT_ADAPTERS.grok.looksLike(["notes.txt"])).toBe(false);
    expect("signInArgs" in ACCOUNT_ADAPTERS.grok).toBe(false);
  });
});

// Masked outputs of `claude auth status`, written by hand from the field list of the probe of 2026-11-16
// (M101 spec 04). Made-up values only; no real login was read to write them.
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone@example.com",
  orgId: "00000000-0000-0000-0000-000000000000",
  orgName: "someone@example.com's Organization",
  subscriptionType: "max",
  planTier: "default_claude_max_20x",
  loginExpiresAt: "2026-12-16T00:00:00.000Z",
  configDirectory: "/home/you/.claude-work",
});
const SIGNED_OUT = JSON.stringify({ loggedIn: false, configDirectory: "/home/you/.claude-new" });

describe("who is signed in: Claude Code's `auth status`", () => {
  const parse = ACCOUNT_ADAPTERS.claude.status.parse;

  test("the command is the agent's own, as fixed words", () => {
    expect(ACCOUNT_ADAPTERS.claude.status.args).toEqual(["auth", "status"]);
    // It runs only where Claude Code has run: its state file, by name, in the folder (or at home for Default).
    expect(ACCOUNT_ADAPTERS.claude.status.needs).toEqual([".claude.json"]);
    expect(ACCOUNT_ADAPTERS.claude.status.needsAtHome).toEqual([".claude.json"]);
    expect(ACCOUNT_ADAPTERS.claude.signInAgainArgs).toEqual(["/login"]);
  });

  test("signed in: the flag, the email and the plan, and nothing else of the answer", () => {
    const identity = parse({ code: 0, stdout: `${SIGNED_IN}\n`, stderr: "" });
    expect(identity).toEqual({ signedIn: true, email: "someone@example.com", plan: "max" });
    const text = JSON.stringify(identity);
    for (const kept of ["Organization", "orgId", "00000000", "planTier", "configDirectory", "/home/you", "loginExpiresAt", "claude.ai"]) expect(text).not.toContain(kept);
  });

  test("not signed in: exit 1 with loggedIn false", () => {
    expect(parse({ code: 1, stdout: SIGNED_OUT, stderr: "" })).toEqual({ signedIn: false });
  });

  test("garbage, a wrong exit code, a killed run or a cut answer is unknown, never an error", () => {
    expect(parse({ code: 0, stdout: "Logged in as someone@example.com", stderr: "" })).toBeNull();
    expect(parse({ code: 0, stdout: "", stderr: "" })).toBeNull();
    expect(parse({ code: 0, stdout: "[]", stderr: "" })).toBeNull();
    expect(parse({ code: 0, stdout: "null", stderr: "" })).toBeNull();
    expect(parse({ code: 2, stdout: SIGNED_IN, stderr: "" })).toBeNull();
    expect(parse({ code: 1, stdout: SIGNED_IN, stderr: "" })).toBeNull();
    // A timeout or an output over the cap is killed, so its code is null.
    expect(parse({ code: null, stdout: SIGNED_IN, stderr: "" })).toBeNull();
    // An answer cut at a cap is not JSON.
    expect(parse({ code: 0, stdout: SIGNED_IN.slice(0, 40), stderr: "" })).toBeNull();
    expect(parse({ code: 0, stdout: JSON.stringify({ loggedIn: "yes", email: "someone@example.com" }), stderr: "" })).toBeNull();
  });

  test("an email or a plan of the wrong shape is left out, the sign-in still counts", () => {
    const over = (fields: JsonObject) => parse({ code: 0, stdout: JSON.stringify({ loggedIn: true, ...fields }), stderr: "" });
    expect(over({})).toEqual({ signedIn: true });
    expect(over({ email: "not an address", subscriptionType: "max plan!" })).toEqual({ signedIn: true });
    expect(over({ email: "someone@example.com‮", subscriptionType: 20 })).toEqual({ signedIn: true });
    expect(over({ email: `${"a".repeat(250)}@example.com` })).toEqual({ signedIn: true });
    expect(over({ email: "someone@example.com", subscriptionType: "pro" })).toEqual({ signedIn: true, email: "someone@example.com", plan: "pro" });
  });

  test("only Claude Code has a status command: Codex, pi and Grok show what they show today", () => {
    expect("status" in ACCOUNT_ADAPTERS.codex).toBe(false);
    expect("status" in ACCOUNT_ADAPTERS.pi).toBe(false);
    expect("status" in ACCOUNT_ADAPTERS.grok).toBe(false);
    expect("signInAgainArgs" in ACCOUNT_ADAPTERS.codex).toBe(false);
  });
});

describe("Change login: what the adapter says about a sign-in", () => {
  test("only Claude Code says a completed sign-in reaches the sessions that run; Codex, pi and Grok are not proven", () => {
    expect(accountAdapter("claude")?.reachesRunningSessions).toBe(true);
    for (const id of ["codex", "pi", "grok"]) expect(accountAdapter(id)?.reachesRunningSessions, id).not.toBe(true);
  });

  test("the sign-in hosts are bare host names: no scheme, no path, no port, no wildcard", () => {
    expect(accountAdapter("claude")?.signInHosts).toEqual(["claude.com", "platform.claude.com"]);
    for (const id of ACCOUNT_HARNESSES) {
      for (const host of accountAdapter(id)?.signInHosts ?? []) expect(host, `${id}: ${host}`).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u);
    }
    for (const id of ["codex", "pi", "grok"]) expect(accountAdapter(id)?.signInHosts, id).toBeUndefined();
  });
});
