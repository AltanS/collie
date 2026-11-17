import { describe, expect, test } from "bun:test";

import { ACCOUNT_ADAPTERS, ACCOUNT_HARNESSES, accountAdapter } from "./account-adapters.ts";
import { accountTest } from "./accounts-skip.ts";
import { harnessLaunch } from "./harness-launch.ts";

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
