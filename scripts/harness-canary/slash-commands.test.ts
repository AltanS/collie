import { describe, expect, test } from "bun:test";
import { ALWAYS_UNSAFE, classifyCommands, loadSlashLists, parseSlashLists, parseSlashMenu } from "./slash-commands";

// M44 spec 05, carried by M56 spec 10: the lab sends only a command that is on the hand-kept safe list.

const GOOD = JSON.stringify({
  claude: {
    safe: [
      { command: "/help", opens: "dialog", reason: "reads only" },
      { command: "/context", opens: "inline", reason: "prints a table" },
    ],
    unsafe: [{ command: "/clear", reason: "wipes the conversation" }],
  },
});

describe("the slash lists", () => {
  test("the shipped file parses, and every entry has a reason", () => {
    const lists = loadSlashLists("claude");
    expect(lists.safe.length).toBeGreaterThan(10);
    for (const entry of [...lists.safe, ...lists.unsafe]) expect(entry.reason.trim().length).toBeGreaterThan(5);
  });

  test("the safe list and the unsafe list share no command", () => {
    const lists = loadSlashLists("claude");
    const safe = new Set(lists.safe.map((entry) => entry.command));
    for (const entry of lists.unsafe) expect(safe.has(entry.command)).toBe(false);
  });

  test("the six commands of the spec are always unsafe and listed so", () => {
    const lists = loadSlashLists("claude");
    for (const command of ALWAYS_UNSAFE) {
      expect(lists.safe.some((entry) => entry.command === command)).toBe(false);
      expect(lists.unsafe.some((entry) => entry.command === command)).toBe(true);
    }
    expect(ALWAYS_UNSAFE).toEqual(["/clear", "/compact", "/logout", "/init", "/review", "/config"]);
  });

  test("a harness that is not in the file has empty lists", () => {
    expect(parseSlashLists(GOOD, "codex")).toEqual({ safe: [], unsafe: [] });
  });

  test("a bad entry is refused and named", () => {
    const bad = (safe: unknown[]): string => JSON.stringify({ claude: { safe, unsafe: [] } });
    expect(() => parseSlashLists(bad([{ command: "help", opens: "dialog", reason: "x" }]), "claude")).toThrow(/claude.safe\[0\]/);
    expect(() => parseSlashLists(bad([{ command: "/help", opens: "dialog", reason: " " }]), "claude")).toThrow(/needs a reason/);
    expect(() => parseSlashLists(bad([{ command: "/help", opens: "maybe", reason: "x" }]), "claude")).toThrow(/opens/);
    expect(() => parseSlashLists(bad([{ command: "/clear", opens: "dialog", reason: "x" }]), "claude")).toThrow(/never be on the safe list/);
    expect(() => parseSlashLists(bad([{ command: "/help", opens: "dialog", reason: "x" }, { command: "/help", opens: "dialog", reason: "x" }]), "claude")).toThrow(/twice/);
  });
});

describe("classifyCommands", () => {
  const lists = parseSlashLists(GOOD, "claude");

  test("a command on neither list is unclassified and is not sent", () => {
    const sorted = classifyCommands(["/help", "/clear", "/mystery", "/other:skill"], lists);
    expect(sorted.send.map((entry) => entry.command)).toEqual(["/help"]);
    expect(sorted.unclassified).toEqual(["/mystery", "/other:skill"]);
    expect(sorted.skipped).toEqual(["/clear"]);
  });

  test("a removed command is reported as removed: not sent, not unclassified, not missing", () => {
    const sorted = classifyCommands(["/help", "/agents", "/context"], lists, ["/agents", "/context"]);
    expect(sorted.send.map((entry) => entry.command)).toEqual(["/help"]);
    expect(sorted.unclassified).toEqual([]);
    expect(sorted.missing).toEqual([]);
    expect(sorted.removed).toEqual(["/agents", "/context"]);
  });

  test("a safe command the agent no longer lists is reported as missing", () => {
    expect(classifyCommands(["/help"], lists).missing).toEqual(["/context"]);
  });
});

describe("parseSlashMenu", () => {
  test("reads the names and the pointed row", () => {
    const rows = ["❯ /help          Show help", "  /status        Show status", "  /model         Pick a model", "other row"];
    expect(parseSlashMenu(rows)).toEqual({ names: ["/help", "/status", "/model"], pointed: "/help", removed: [] });
  });

  test("a row whose description opens with (removed) marks the command removed (Claude 2.1.302)", () => {
    const rows = ["  ❯ /agents                     (removed) Ask Claude to create/manage subagents, or edit .claude/agents/", "    /list-agents                List subagents, teammates, and other Claude sessions"];
    expect(parseSlashMenu(rows)).toEqual({ names: ["/agents", "/list-agents"], pointed: "/agents", removed: ["/agents"] });
  });

  test("no pointer is null", () => {
    expect(parseSlashMenu(["  /help          Show help"]).pointed).toBeNull();
  });
});
