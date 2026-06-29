import { commandsFor } from "./agent-commands";

describe("commandsFor", () => {
  it("returns the Claude catalog for 'claude'", () => {
    const cmds = commandsFor("claude");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/compact")).toBe(true);
  });

  it("returns the Codex catalog for 'codex'", () => {
    const cmds = commandsFor("codex");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/new")).toBe(true); // Codex-only command
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // Claude-only command
  });

  it("is case-insensitive", () => {
    expect(commandsFor("CLAUDE")).toBe(commandsFor("claude"));
    expect(commandsFor("Codex")).toBe(commandsFor("codex"));
  });

  it("trims surrounding whitespace", () => {
    expect(commandsFor("  claude  ")).toBe(commandsFor("claude"));
  });

  it("tolerates label variants via prefix (claude-code, codex-cli)", () => {
    expect(commandsFor("claude-code")).toBe(commandsFor("claude"));
    expect(commandsFor("codex-cli")).toBe(commandsFor("codex"));
  });

  it("returns [] for unknown / absent agents", () => {
    expect(commandsFor("gemini")).toEqual([]);
    expect(commandsFor("")).toEqual([]);
    expect(commandsFor(undefined)).toEqual([]);
    expect(commandsFor(null)).toEqual([]);
  });

  it("exposes a 'common' subset that is a proper, non-empty subset of all commands", () => {
    const all = commandsFor("claude");
    const common = all.filter((c) => c.common);
    expect(common.length).toBeGreaterThan(0);
    expect(common.length).toBeLessThan(all.length);
    // Every common command is part of the full catalog.
    expect(common.every((c) => all.includes(c))).toBe(true);
  });
});
