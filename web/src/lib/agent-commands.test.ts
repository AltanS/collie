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

  it("returns the Grok catalog for 'grok'", () => {
    const cmds = commandsFor("grok");
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.command === "/always-approve")).toBe(true);
    expect(cmds.some((c) => c.command === "/tree")).toBe(false);
    // One tap from a phone would skip every tool-permission prompt (xAI: `/always-approve`
    // bypasses those prompts; deny rules and hooks still apply). Two-tap like /quit / /new.
    expect(cmds.find((c) => c.command === "/always-approve")?.dangerous).toBe(true);
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

  it("returns the agy catalog for 'agy' and 'antigravity'", () => {
    const agyCmds = commandsFor("agy");
    expect(agyCmds.length).toBeGreaterThan(0);
    expect(agyCmds.some((c) => c.command === "/grill-me")).toBe(true);
    expect(agyCmds.some((c) => c.command === "/learn")).toBe(true);
    expect(commandsFor("antigravity")).toEqual(agyCmds);
    expect(commandsFor("agy-cli")).toEqual(agyCmds);
  });

  it("is case-insensitive", () => {
    expect(commandsFor("CLAUDE")).toBe(commandsFor("claude"));
    expect(commandsFor("Codex")).toBe(commandsFor("codex"));
    expect(commandsFor("PI")).toBe(commandsFor("pi"));
    expect(commandsFor("OpenCode")).toBe(commandsFor("opencode"));
    expect(commandsFor("OMP")).toBe(commandsFor("omp"));
    expect(commandsFor("GROK")).toBe(commandsFor("grok"));
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
    expect(commandsFor("grok-build")).toBe(commandsFor("grok"));
  });

  it("returns [] for unknown / absent agents", () => {
    expect(commandsFor("gemini")).toEqual([]);
    expect(commandsFor("")).toEqual([]);
    expect(commandsFor(undefined)).toEqual([]);
    expect(commandsFor(null)).toEqual([]);
  });

  // The catalog is a plain object, so these agent strings index straight into Object.prototype. A
  // truthy lookup handed the inherited FUNCTION back as if it were a command array, and
  // command-palette.tsx calls .filter on what it gets — so a pane whose agent Herdr reported as
  // "constructor" took the whole palette down with a TypeError. Same hardening quick-replies.ts and
  // adapterFor() already carry.
  it("returns [] for an agent that spells an inherited Object.prototype member", () => {
    for (const agent of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const cmds = commandsFor(agent);
      expect(Array.isArray(cmds)).toBe(true);
      expect(cmds).toEqual([]);
      expect(() => cmds.filter((c) => c.common)).not.toThrow();
    }
  });

  it.each(["claude", "codex", "pi", "opencode", "omp", "grok"])(
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

  it.each(["claude", "codex", "pi", "opencode", "omp", "grok"])(
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

// The operator's own rows (commands.toml → /api/config). The shipped catalogs cannot carry a
// plugin- or user-registered command, and a list half-chosen by you and half-guessed for you is
// worse than either — so a pane your rows address shows your rows and nothing else.
describe("commandsFor with the operator's own rows", () => {
  const forkIn = {
    agent: "omp",
    command: "/fork-in-herdr",
    description: "Fork into a new herdr tab",
    takesArg: false,
    argHint: "",
  };

  it("replaces the catalog on the panes it addresses", () => {
    const omp = commandsFor("omp", [forkIn]);
    expect(omp.map((c) => c.command)).toEqual(["/fork-in-herdr"]);
    // The shipped rows are gone, not merged: this surface is the operator's shortcuts now.
    expect(omp.some((c) => c.command === "/compact")).toBe(false);
  });

  it("leaves a pane none of your rows address exactly as shipped", () => {
    // Scoping rows to omp says nothing about your claude panes, so they are not part of the choice.
    expect(commandsFor("claude", [forkIn])).toEqual(commandsFor("claude"));
    expect(commandsFor("claude", [forkIn]).some((c) => c.command === "/fork-in-herdr")).toBe(false);
  });

  it("matches the scope through the same variant tolerance as the catalog lookup", () => {
    expect(commandsFor(" OMP ", [forkIn]).some((c) => c.command === "/fork-in-herdr")).toBe(true);
  });

  it("surfaces extras on the first screen, never as a two-tap confirm", () => {
    const row = commandsFor("omp", [forkIn]).find((c) => c.command === "/fork-in-herdr");
    expect(row?.common).toBe(true);
    expect(row?.dangerous).toBe(false);
    expect(row?.description).toBe("Fork into a new herdr tab");
  });

  it("gives an agent with no catalog a palette when an unscoped extra applies", () => {
    const unscoped = { command: "/deploy", description: "Ship it", takesArg: false, argHint: "" };
    expect(commandsFor("gemini")).toEqual([]);
    expect(commandsFor("gemini", [unscoped]).map((c) => c.command)).toEqual(["/deploy"]);
    // Including a pane with no detected agent at all, where the button would otherwise never show.
    expect(commandsFor(null, [unscoped]).map((c) => c.command)).toEqual(["/deploy"]);
  });

  it("renders one button, not two, when a row names a shipped command", () => {
    const override = {
      agent: "omp",
      command: "/compact",
      description: "My own wording",
      takesArg: false,
      argHint: "",
    };
    const rows = commandsFor("omp", [override]);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("My own wording");
  });

  it("carries an arg-taking extra through with its hint", () => {
    const withArg = {
      agent: "omp",
      command: "/label",
      description: "Rename the pane",
      takesArg: true,
      argHint: "<name>",
    };
    const row = commandsFor("omp", [withArg]).find((c) => c.command === "/label");
    expect(row?.takesArg).toBe(true);
    expect(row?.argHint).toBe("<name>");
  });

  it("is unchanged by an empty extras list", () => {
    expect(commandsFor("omp", [])).toEqual(commandsFor("omp"));
  });

  it("keeps a shipped row's confirm when an extra renames it", () => {
    // The two-tap confirm belongs to the command, not to the text describing it. Re-wording a
    // session wipe must not be a way — least of all an unwitting one — to make it one tap.
    const shipped = commandsFor("omp").find((c) => c.command === "/new");
    expect(shipped?.dangerous).toBe(true);
    const override = {
      agent: "omp",
      command: "/new",
      description: "Fresh start",
      takesArg: false,
      argHint: "",
    };
    const row = commandsFor("omp", [override]).find((c) => c.command === "/new");
    expect(row?.description).toBe("Fresh start");
    expect(row?.dangerous).toBe(true);
  });

  it("confirms a row the operator marked, and treats inheriting as a floor", () => {
    // `confirm = true` buys the same two-tap a shipped dangerous command gets, on a command nothing
    // out here knows anything about.
    const mine = {
      agent: "omp",
      command: "/wipe-prod",
      description: "Wipe staging",
      takesArg: false,
      argHint: "",
      confirm: true,
    };
    expect(commandsFor("omp", [mine])[0].dangerous).toBe(true);
    // …and `confirm = false` is not a way OUT of rule 3: the shipped classification is a floor.
    const renamed = { ...mine, command: "/new", description: "Fresh start", confirm: false };
    expect(commandsFor("omp", [renamed])[0].dangerous).toBe(true);
  });

  it("resolves a scoped and an unscoped row for one command to a single scoped button", () => {
    // "everywhere, except here" is the obvious use of a scope. Two rows with one /name would also
    // collide on the palette's React key.
    const extras = [
      { command: "/deploy", description: "Everywhere", takesArg: false, argHint: "" },
      { agent: "omp", command: "/deploy", description: "On omp", takesArg: false, argHint: "" },
    ];
    const omp = commandsFor("omp", extras).filter((c) => c.command === "/deploy");
    expect(omp.map((c) => c.description)).toEqual(["On omp"]);
    // Declaration order must not decide it.
    const flipped = commandsFor("omp", [extras[1], extras[0]]).filter((c) => c.command === "/deploy");
    expect(flipped.map((c) => c.description)).toEqual(["On omp"]);
    // Every other pane still gets the global row.
    expect(
      commandsFor("claude", extras).filter((c) => c.command === "/deploy").map((c) => c.description),
    ).toEqual(["Everywhere"]);
  });

  it("reaches an agent variant the same way its catalog does", () => {
    const mine = { agent: "claude", command: "/mine", description: "Mine", takesArg: false, argHint: "" };
    // The scope resolves the variant, and having done so it owns that pane's palette.
    expect(commandsFor("claude-code", [mine]).map((c) => c.command)).toEqual(["/mine"]);
  });

  it("does not let the catalog's prefix tolerance widen a narrow scope", () => {
    // "claude-local:" folds onto CLAUDE for the CATALOG lookup, but the operator typed a name for
    // one pane. Reading it as the whole family is the same failure as treating ":/cmd" as global.
    const local = { agent: "claude-local", command: "/deploy", description: "Local", takesArg: false, argHint: "" };
    expect(commandsFor("claude", [local]).some((c) => c.command === "/deploy")).toBe(false);
    expect(commandsFor("claude-code", [local]).some((c) => c.command === "/deploy")).toBe(false);
    expect(commandsFor("claude-local", [local]).some((c) => c.command === "/deploy")).toBe(true);
    // Same for every other family with a bare-prefix rule.
    const omp = { agent: "omp-experimental", command: "/deploy", description: "X", takesArg: false, argHint: "" };
    expect(commandsFor("omp", [omp]).some((c) => c.command === "/deploy")).toBe(false);
  });

  it("prefers the exact scope over the family one, whichever was declared first", () => {
    const family = { agent: "claude", command: "/deploy", description: "Family", takesArg: false, argHint: "" };
    const exact = { agent: "claude-code", command: "/deploy", description: "Exact", takesArg: false, argHint: "" };
    const pick = (extras: typeof family[]) =>
      commandsFor("claude-code", extras).filter((c) => c.command === "/deploy").map((c) => c.description);
    expect(pick([family, exact])).toEqual(["Exact"]);
    expect(pick([exact, family])).toEqual(["Exact"]);
    // …and the family row still reaches a variant pane when it is the only one aimed there.
    expect(pick([family])).toEqual(["Family"]);
    expect(
      commandsFor("claude", [family, exact]).filter((c) => c.command === "/deploy").map((c) => c.description),
    ).toEqual(["Family"]);
  });

  it("scopes to an agent Collie ships no catalog for", () => {
    const mine = { agent: "aider", command: "/mine", description: "Mine", takesArg: false, argHint: "" };
    expect(commandsFor("aider", [mine]).map((c) => c.command)).toEqual(["/mine"]);
    expect(commandsFor("omp", [mine]).some((c) => c.command === "/mine")).toBe(false);
  });
});
