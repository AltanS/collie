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
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // in Claude's and omp's, not here
  });

  it("returns the Pi catalog for 'pi'", () => {
    const cmds = commandsFor("pi");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/tree")).toBe(true); // Pi-specific command
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // in Claude's and omp's, not here
  });

  it("returns the opencode catalog for 'opencode'", () => {
    const cmds = commandsFor("opencode");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/unshare")).toBe(true); // opencode-specific command
    expect(cmds.some((c) => c.command === "/branch")).toBe(false); // in Claude's and omp's, not here
  });

  it("returns the omp catalog for 'omp'", () => {
    const cmds = commandsFor("omp");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/plan-review")).toBe(true); // omp-specific command
    // The corpus vouches for a command in three ways and the catalog reads all three, so a palette
    // row is not the only thing that gets in: /shake and /compact are named by omp's own tip line,
    // and /model was typed to produce omp--menu-model.txt. What stays out is anything the corpus is
    // silent on — /init is Claude's and appears in no omp capture, so it must not be typed at omp.
    expect(cmds.some((c) => c.command === "/shake")).toBe(true); // omp's tip line names it
    expect(cmds.some((c) => c.command === "/model")).toBe(true); // typed to produce a fixture
    expect(cmds.some((c) => c.command === "/init")).toBe(false); // vouched for by nothing in the corpus
  });

  // omp is NOT pi: the two are different CLIs with different command sets, and `commandsFor`'s prefix
  // tolerance has to keep them apart in both directions or an omp user gets pi's palette.
  it("does not route omp to the Pi catalog, or pi to omp's", () => {
    expect(commandsFor("omp")).not.toBe(commandsFor("pi"));
    expect(commandsFor("omp").some((c) => c.command === "/tree")).toBe(false); // Pi-specific
    expect(commandsFor("pi").some((c) => c.command === "/plan-review")).toBe(false); // omp-specific
  });

  // The palette captures this catalog was sourced from also list rows omp assembled from the
  // capturing user's own machine (`skill:…`). Those are not omp built-ins and must never ship.
  it("carries no entry sourced from the capturing user's machine", () => {
    for (const c of commandsFor("omp")) {
      expect(c.command.includes("skill:"), c.command).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(commandsFor("CLAUDE")).toBe(commandsFor("claude"));
    expect(commandsFor("Codex")).toBe(commandsFor("codex"));
    expect(commandsFor("PI")).toBe(commandsFor("pi"));
    expect(commandsFor("OpenCode")).toBe(commandsFor("opencode"));
    expect(commandsFor("OMP")).toBe(commandsFor("omp"));
  });

  it("trims surrounding whitespace", () => {
    expect(commandsFor("  claude  ")).toBe(commandsFor("claude"));
  });

  it("tolerates label variants via prefix (claude-code, codex-cli, opencode-dev)", () => {
    expect(commandsFor("claude-code")).toBe(commandsFor("claude"));
    expect(commandsFor("codex-cli")).toBe(commandsFor("codex"));
    expect(commandsFor("opencode-dev")).toBe(commandsFor("opencode"));
    expect(commandsFor("pi-go")).toBe(commandsFor("pi"));
    expect(commandsFor("omp-dev")).toBe(commandsFor("omp"));
  });

  it("returns [] for unknown / absent agents", () => {
    expect(commandsFor("gemini")).toEqual([]);
    expect(commandsFor("")).toEqual([]);
    expect(commandsFor(undefined)).toEqual([]);
    expect(commandsFor(null)).toEqual([]);
  });

  it.each(["claude", "codex", "pi", "opencode", "omp"])(
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

  it.each(["claude", "codex", "pi", "opencode", "omp"])(
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
