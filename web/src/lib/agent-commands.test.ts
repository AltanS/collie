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

  it("returns the Pi catalog for 'pi'", () => {
    const cmds = commandsFor("pi");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/tree")).toBe(true); // Pi-specific command
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // Claude-only command
  });

  it("returns the opencode catalog for 'opencode'", () => {
    const cmds = commandsFor("opencode");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/unshare")).toBe(true); // opencode-specific command
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // Claude-only command
  });

  it("is case-insensitive", () => {
    expect(commandsFor("CLAUDE")).toBe(commandsFor("claude"));
    expect(commandsFor("Codex")).toBe(commandsFor("codex"));
    expect(commandsFor("PI")).toBe(commandsFor("pi"));
    expect(commandsFor("OpenCode")).toBe(commandsFor("opencode"));
  });

  it("trims surrounding whitespace", () => {
    expect(commandsFor("  claude  ")).toBe(commandsFor("claude"));
  });

  it("tolerates label variants via prefix (claude-code, codex-cli, opencode-dev)", () => {
    expect(commandsFor("claude-code")).toBe(commandsFor("claude"));
    expect(commandsFor("codex-cli")).toBe(commandsFor("codex"));
    expect(commandsFor("opencode-dev")).toBe(commandsFor("opencode"));
    expect(commandsFor("pi-go")).toBe(commandsFor("pi"));
  });

  it("returns [] for unknown / absent agents", () => {
    expect(commandsFor("gemini")).toEqual([]);
    expect(commandsFor("")).toEqual([]);
    expect(commandsFor(undefined)).toEqual([]);
    expect(commandsFor(null)).toEqual([]);
  });

  it.each(["claude", "codex", "pi", "opencode"])(
    "exposes for '%s' a 'common' subset that is a proper, non-empty subset of all commands",
    (agent) => {
      const all = commandsFor(agent);
      const common = all.filter((c) => c.common);
      expect(common.length).toBeGreaterThan(0);
      expect(common.length).toBeLessThan(all.length);
      // Every common command is part of the full catalog.
      expect(common.every((c) => all.includes(c))).toBe(true);
    },
  );

  it.each(["claude", "codex", "pi", "opencode"])(
    "'%s' entries are well-formed (slash-prefixed, unique, arg hints only when takesArg)",
    (agent) => {
      const all = commandsFor(agent);
      const seen = new Set<string>();
      for (const c of all) {
        expect(c.command.startsWith("/")).toBe(true);
        expect(seen.has(c.command)).toBe(false); // no duplicate commands within a catalog
        seen.add(c.command);
        expect(c.description.length).toBeGreaterThan(0);
        if (c.takesArg) expect(c.argHint.length).toBeGreaterThan(0);
        else expect(c.argHint).toBe("");
      }
    },
  );
});
