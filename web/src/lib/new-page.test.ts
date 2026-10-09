import {
  AGAIN_KEY,
  KIND_KEY,
  MAX_AGAIN,
  NEW_PAGE_DOCS,
  RECENT_OPTION_CHARS,
  TYPED_KEY,
  agentChoice,
  branchAllowed,
  commandChoice,
  commandKey,
  commandOptions,
  defaultKind,
  folderShown,
  itemOf,
  keyToWhat,
  kindOf,
  kindOfKey,
  machineWord,
  offerFor,
  offered,
  optionText,
  pickOfKey,
  readAgain,
  readKind,
  rememberAgain,
  rememberKind,
  runLine,
  startFingerprint,
  startableAgents,
  summaryKey,
  summaryWhat,
  truncateLine,
  unavailableText,
  whatFor,
  whatLabel,
  type LastStart,
} from "./new-page";
import { hostHealth } from "./host-health";
import type { HarnessInfo, Launcher, LauncherItem, RecentRun, ServerSummary } from "./types";

// The New page's rules (M48 spec 01): what is offered and what is listed as not working, the summary's
// sentence, the Again and Agent-or-Shell memories, and when a retry may keep its request id.

const CLAUDE: HarnessInfo = { id: "claude", label: "Claude Code", found: true };
const GROK: HarnessInfo = { id: "grok", label: "Grok", found: false };
const HTOP: Launcher = { command: "htop", label: "htop" };

const item = (over: Partial<LauncherItem> & Pick<LauncherItem, "key" | "start" | "group" | "label">): LauncherItem => ({
  source: "builtin",
  noPrompts: false,
  branch: false,
  available: true,
  ...over,
});

/** What a 1.19.0 bridge sends: a built-in agent, an added agent row, the shell, a command row, an off row. */
const ITEMS: LauncherItem[] = [
  item({ key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude", branch: true }),
  item({
    key: "row:claude --model opus",
    start: { command: "claude --model opus" },
    group: "agents",
    label: "Claude, opus",
    harness: "claude",
    command: "claude --model opus",
    source: "added",
    branch: true,
    id: "r1",
    addedBy: "phone",
  }),
  item({
    key: "row:claude --dangerously-skip-permissions",
    start: { command: "claude --dangerously-skip-permissions" },
    group: "agents",
    label: "Claude, no prompts",
    harness: "claude",
    command: "claude --dangerously-skip-permissions",
    source: "added",
    branch: true,
    noPrompts: true,
    id: "r2",
  }),
  item({ key: "shell", start: { shell: true }, group: "commands", label: "Shell", branch: true }),
  item({ key: "row:make test", start: { command: "make test" }, group: "commands", label: "make test", command: "make test", source: "operator" }),
  item({
    key: "row:htop --typed",
    start: { command: "htop --typed" },
    group: "commands",
    label: "typed",
    command: "htop --typed",
    source: "added",
    available: false,
    reason: "free_text_off",
  }),
];

/** A Storage stand-in. */
function memory(): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("offerFor", () => {
  const base = { harnesses: [CLAUDE, GROK], loaded: true, rows: [HTOP], canWorktree: true };

  it("lists every agent the machine knows; one not installed stays, with its reason, never hidden", () => {
    const offer = offerFor(base);
    expect(offer.agents.map((a) => [a.key, a.label, a.unavailable])).toEqual([
      ["harness:claude", "Claude Code", null],
      ["harness:grok", "Grok", { kind: "notFound" }],
    ]);
    expect(startableAgents(offer).map((a) => a.key)).toEqual(["harness:claude"]);
    expect(offer.commands.map((c) => c.key)).toEqual(["shell", "row:htop"]);
    expect(offer.branchBlocked).toBeNull();
    expect(offer.agentsNote).toBeNull();
  });

  it("an older Collie: no agents, a note that says why, no worktrees, the shell by the old route", () => {
    const offer = offerFor({ ...base, harnesses: null });
    expect(offer.agents).toEqual([]);
    expect(offer.shellById).toBe(false);
    expect(offer.agentsNote).toEqual({ kind: "olderCollie" });
    expect(offer.branchBlocked).toEqual({ kind: "olderCollie" });
  });

  it("an answer not in yet is not an older Collie", () => {
    const offer = offerFor({ ...base, harnesses: null, loaded: false });
    expect(offer.agentsNote).toBeNull();
    expect(offer.branchBlocked).toBeNull();
  });

  it("no worktrees: the worktree switch says it needs Herdr; a member: only on the lead", () => {
    expect(offerFor({ ...base, canWorktree: false }).branchBlocked).toEqual({ kind: "needsHerdr" });
    expect(offerFor({ ...base, memberChosen: { lead: "bluefin" } }).branchBlocked).toEqual({
      kind: "onlyOnLead",
      lead: "bluefin",
    });
  });

  it("a machine that takes no writes offers nothing, and its sentence blocks the worktree", () => {
    const offer = offerFor({ ...base, refusal: "minibuch is not reachable" });
    expect(offer.agents).toEqual([]);
    expect(offer.commands.map((c) => c.key)).toEqual(["shell"]);
    expect(offer.branchBlocked).toEqual({ kind: "machine", sentence: "minibuch is not reachable" });
  });
});

describe("offerFor with the bridge's items", () => {
  const offer = offerFor({ harnesses: [CLAUDE], items: ITEMS, loaded: true, rows: [], canWorktree: true });

  it("the Agent select holds the built-in agents and the agent rows; the Command select leads with the shell", () => {
    expect(offer.agents.map((a) => a.key)).toEqual(["harness:claude", "row:claude --model opus", "row:claude --dangerously-skip-permissions"]);
    expect(offer.commands.map((c) => c.key)).toEqual(["shell", "row:make test", "row:htop --typed"]);
    expect(offer.shellById).toBe(true);
    expect(offer.agentsNote).toBeNull();
  });

  it("an item the machine cannot start stays listed, disabled, with the bridge's reason", () => {
    expect(offer.commands[2]?.unavailable).toEqual({ kind: "freeTextOff" });
    expect(startableAgents(offer)).toHaveLength(3);
    expect(offered(offer, { kind: "row", command: "htop --typed" })).toBe(false);
    expect(offered(offer, { kind: "row", command: "make test" })).toBe(true);
  });

  it("puts the Shell first whatever order the bridge sent", () => {
    const shuffled = offerFor({ harnesses: [CLAUDE], items: ITEMS.toReversed(), loaded: true, rows: [], canWorktree: true });
    expect(shuffled.commands[0]?.key).toBe("shell");
  });

  it("an item with noPrompts says so in its option text, and a reason follows in brackets", () => {
    expect(optionText(offer.agents[2]!, "Shell")).toBe("Claude, no prompts (No prompts)");
    expect(optionText(offer.agents[0]!, "Shell")).toBe("Claude Code");
    expect(optionText(offer.commands[0]!, "Shell")).toBe("Shell");
    expect(optionText(offer.commands[2]!, "Shell")).toBe("typed (typed lines are turned off on this machine)");
    expect(itemOf(offer, { kind: "row", command: "claude --dangerously-skip-permissions" })?.noPrompts).toBe(true);
  });

  it("an item carries its fixed folder and its harness for the icon", () => {
    const pinned = offerFor({
      harnesses: [CLAUDE],
      items: [item({ key: "row:make test", start: { command: "make test" }, group: "commands", label: "make test", command: "make test", cwd: "/srv" })],
      loaded: true,
      rows: [],
      canWorktree: true,
    });
    expect(itemOf(pinned, { kind: "row", command: "make test" })?.cwd).toBe("/srv");
    expect(offer.agents[1]?.harness).toBe("claude");
  });

  it("a bridge older than 1.19.0 sends no items: today's lists from the agents and the rows", () => {
    const old = offerFor({ harnesses: [CLAUDE], loaded: true, rows: [HTOP, { command: "x --yolo", label: "x", noPrompts: true }], canWorktree: true });
    expect(old.agents.map((a) => a.key)).toEqual(["harness:claude"]);
    expect(old.commands.map((c) => c.key)).toEqual(["shell", "row:htop", "row:x --yolo"]);
    // A row that says so (an operator's `no_prompts`) keeps its badge even without items.
    expect(old.commands[2]?.noPrompts).toBe(true);
    expect(old.commands[1]?.noPrompts).toBe(false);
  });

  it("the Command select's options come from one function: Just a shell first, then the rows", () => {
    expect(commandOptions(offer, "Just a shell")).toEqual([
      { key: "shell", text: "Just a shell", disabled: false, group: "rows" },
      { key: "row:make test", text: "make test", disabled: false, group: "rows" },
      { key: "row:htop --typed", text: "typed (typed lines are turned off on this machine)", disabled: true, group: "rows" },
    ]);
  });

  it("an item key names a choice back, and says which select holds it", () => {
    expect(keyToWhat("shell")).toEqual({ kind: "shell" });
    expect(keyToWhat("harness:claude")).toEqual({ kind: "harness", id: "claude" });
    expect(keyToWhat("row:make test")).toEqual({ kind: "row", command: "make test" });
    expect(keyToWhat("row:")).toBeNull();
    expect(keyToWhat("nonsense")).toBeNull();
    expect(keyToWhat(undefined)).toBeNull();
    expect(kindOfKey(offer, "row:claude --model opus")).toBe("agent");
    expect(kindOfKey(offer, "row:make test")).toBe("shell");
    expect(kindOfKey(offer, "row:gone")).toBeNull();
    expect(kindOfKey(offer, undefined)).toBeNull();
  });
});

// ── One-off commands and their history (ADR 0095) ───────────────────────────────────────────────

const RECENT: RecentRun[] = [
  { line: "make deploy", cwd: "/srv/app", at: 3, noPrompts: false, available: true },
  { line: "claude --dangerously-skip-permissions", cwd: null, at: 2, noPrompts: true, available: true },
  { line: "x".repeat(RECENT_OPTION_CHARS + 20), cwd: null, at: 1, noPrompts: false, available: true },
];

describe("the Command select's list in each switch state", () => {
  const input = { harnesses: [CLAUDE], items: ITEMS, loaded: true, rows: [], canWorktree: true } as const;
  const again = (what: LastStart["what"]): LastStart => ({ what, label: "x", cwd: null, branch: null, at: 1 });
  const keys = (offer: ReturnType<typeof offerFor>) => commandOptions(offer, "Just a shell").map((o) => [o.group, o.key]);

  it("a bridge that reports no `adding.run` shows neither Recent nor Type a command", () => {
    const old = offerFor({ ...input, recentRuns: RECENT });
    expect(old.canRun).toBe(false);
    expect(old.recent).toEqual([]);
    expect(commandOptions(old, "Just a shell").map((o) => o.group)).toEqual(["rows", "rows", "rows"]);
  });

  it("run on: Just a shell, the rows, the Recent group newest first, and Type a command last", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    expect(keys(offer)).toEqual([
      ["rows", "shell"],
      ["rows", "row:make test"],
      ["rows", "row:htop --typed"],
      ["recent", "run:make deploy"],
      ["recent", "run:claude --dangerously-skip-permissions"],
      ["recent", `run:${"x".repeat(RECENT_OPTION_CHARS + 20)}`],
      ["typed", TYPED_KEY],
    ]);
    const texts = commandOptions(offer, "Just a shell").map((o) => o.text);
    expect(texts[3]).toBe("make deploy");
    // The badge is in words, after the line.
    expect(texts[4]).toBe("claude --dangerously-skip-permissions (No prompts)");
    // A long line is cut in the option, whole in the entry.
    expect(texts[5]).toBe(`${"x".repeat(RECENT_OPTION_CHARS - 1)}…`);
    expect(offer.recent[2]?.line).toBe("x".repeat(RECENT_OPTION_CHARS + 20));
    expect(texts[6]).toBe("Type a command…");
    expect(commandOptions(offer, "Just a shell").every((o) => !o.disabled || o.key === "row:htop --typed")).toBe(true);
  });

  it("run on with no history: Type a command is the only addition, and there is no empty Recent group", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: [] });
    expect(commandOptions(offer, "Just a shell").map((o) => o.group)).toEqual(["rows", "rows", "rows", "typed"]);
    expect(offerFor({ ...input, run: true }).recent).toEqual([]);
  });

  it("run off: the history stays listed, each entry disabled with its reason, and there is no Type a command", () => {
    const off = RECENT.map((e) => ({ ...e, available: false, reason: "run_off" as const }));
    const offer = offerFor({ ...input, run: false, recentRuns: off });
    const options = commandOptions(offer, "Just a shell");
    expect(options.map((o) => o.group)).toEqual(["rows", "rows", "rows", "recent", "recent", "recent"]);
    expect(options[3]).toEqual({
      key: "run:make deploy",
      text: "make deploy (one-off commands are turned off on this machine)",
      disabled: true,
      group: "recent",
    });
    expect(offer.canRun).toBe(false);
    // Whatever the entries say, a switch that is off disables them.
    expect(offerFor({ ...input, run: false, recentRuns: RECENT }).recent.every((r) => r.unavailable?.kind === "runOff")).toBe(true);
  });

  it("an entry the bridge marks unavailable is disabled even while the switch is on", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: [{ ...RECENT[0]!, available: false, reason: "run_off" }] });
    expect(offer.recent[0]?.unavailable).toEqual({ kind: "runOff" });
  });

  it("a machine that takes no writes offers neither", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT, refusal: "minibuch is not reachable" });
    expect(offer.recent).toEqual([]);
    expect(offer.canRun).toBe(false);
  });

  it("an entry carries its line, its folder and its stored no-prompts answer", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    expect(offer.recent[0]).toMatchObject({ line: "make deploy", runCwd: "/srv/app", noPrompts: false, branch: false });
    expect(offer.recent[1]).toMatchObject({ noPrompts: true, command: "claude --dangerously-skip-permissions", runCwd: null });
    expect(itemOf(offer, { kind: "run", line: "make deploy" })?.key).toBe("run:make deploy");
  });

  it("truncates by characters, not bytes", () => {
    expect(truncateLine("htop")).toBe("htop");
    const wide = "界".repeat(RECENT_OPTION_CHARS + 1);
    expect([...truncateLine(wide)]).toHaveLength(RECENT_OPTION_CHARS);
  });

  it("the keys round trip: a run key names its line, the typed key names the typed choice", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    expect(keyToWhat("run:make deploy")).toEqual({ kind: "run", line: "make deploy" });
    expect(keyToWhat("run:")).toBeNull();
    expect(pickOfKey(offer, "run:make deploy")).toEqual({ kind: "run", line: "make deploy" });
    expect(pickOfKey(offer, TYPED_KEY)).toEqual({ kind: "typed" });
    expect(pickOfKey(offerFor({ ...input, run: false }), TYPED_KEY)).toBeNull();
    expect(pickOfKey(offer, "run:gone")).toBeNull();
    expect(commandKey({ kind: "typed" })).toBe(TYPED_KEY);
    expect(commandKey({ kind: "run", line: "htop" })).toBe("run:htop");
    expect(kindOfKey(offer, "run:make deploy")).toBe("shell");
    expect(kindOf({ kind: "run", line: "htop" })).toBe("shell");
  });

  it("the Command select opens on the pick, else Again's line, only while it can run", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    const line = { kind: "run", line: "make deploy" } as const;
    expect(commandChoice(offer, line, null)).toEqual(line);
    expect(commandChoice(offer, { kind: "typed" }, null)).toEqual({ kind: "typed" });
    expect(commandChoice(offer, null, again(line))).toEqual(line);
    // An Again line the history no longer holds is not selected (the page brings it back through the field).
    expect(commandChoice(offer, null, again({ kind: "run", line: "gone" }))).toEqual({ kind: "shell" });
    const off = offerFor({ ...input, run: false, recentRuns: RECENT });
    expect(commandChoice(off, line, null)).toEqual({ kind: "shell" });
    expect(commandChoice(off, { kind: "typed" }, null)).toEqual({ kind: "shell" });
  });

  it("Start takes the typed line in Shell, trimmed, and nothing while the field is empty", () => {
    expect(whatFor("shell", null, { kind: "typed" }, "  htop  ")).toEqual({ kind: "run", line: "htop" });
    expect(whatFor("shell", null, { kind: "typed" }, "   ")).toBeNull();
    expect(whatFor("shell", null, { kind: "run", line: "make deploy" }, "")).toEqual({ kind: "run", line: "make deploy" });
    // The field is only the typed choice's: in Agent it is ignored.
    expect(whatFor("agent", null, { kind: "typed" }, "htop")).toBeNull();
    expect(runLine("  caf\u0065\u0301 ")).toBe("caf\u00e9");
  });

  it("a one-off line never starts a worktree, and Again can repeat it while runs are on", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    expect(branchAllowed(offer, { kind: "run", line: "make deploy" })).toBe(false);
    expect(offered(offer, { kind: "run", line: "anything not in the history" })).toBe(true);
    expect(offered(offerFor({ ...input, run: false, recentRuns: RECENT }), { kind: "run", line: "make deploy" })).toBe(false);
  });

  it("the summary reads Runs `line` for a one-off, the label for the rest", () => {
    const offer = offerFor({ ...input, run: true, recentRuns: RECENT });
    expect(summaryWhat({ kind: "run", line: "htop" }, offer, "Shell")).toBe("Runs `htop`");
    expect(summaryWhat({ kind: "shell" }, offer, "Shell")).toBe("Shell");
    expect(whatLabel({ kind: "run", line: "htop" }, offer, "Shell")).toBe("htop");
  });
});

describe("unavailableText", () => {
  it("says each reason in words short enough for brackets", () => {
    expect(unavailableText({ kind: "notFound" })).toBe("not installed");
    expect(unavailableText({ kind: "needsHerdr" })).toBe("needs Herdr");
    expect(unavailableText({ kind: "onlyOnLead", lead: "bluefin" })).toBe("only on bluefin");
    expect(unavailableText({ kind: "olderCollie" })).toMatch(/older Collie/);
    expect(unavailableText({ kind: "addsOff" })).toBe("turned off on this machine");
    expect(unavailableText({ kind: "freeTextOff" })).toBe("typed lines are turned off on this machine");
    expect(unavailableText({ kind: "commandRow" })).toBe("a command cannot start in a new worktree");
    expect(unavailableText({ kind: "machine", sentence: "gone" })).toBe("gone");
  });
});

describe("machineWord", () => {
  const server = (over: Partial<ServerSummary>): ServerSummary => ({
    id: "mini",
    name: "minibuch",
    isLead: false,
    reachable: true,
    protocol: "ok",
    lastSeenAt: 0,
    ...over,
  });
  const health = (s: ServerSummary) => hostHealth(s, { at: 0, pollMs: 0 });

  it("is nothing for a machine that takes writes, a word for one that does not", () => {
    expect(machineWord(health(server({})))).toBeUndefined();
    expect(machineWord(health(server({ reachable: false })))).toBe("unreachable");
  });
});

describe("the choice", () => {
  const offer = offerFor({ harnesses: [CLAUDE, GROK], loaded: true, rows: [HTOP], canWorktree: true });
  const again = (what: LastStart["what"]): LastStart => ({ what, label: "x", cwd: null, branch: null, at: 1 });

  it("the Agent select opens on the pick, else Again's agent, else the first that starts", () => {
    expect(agentChoice(offer, null, null)?.key).toBe("harness:claude");
    expect(agentChoice(offer, "harness:claude", null)?.key).toBe("harness:claude");
    expect(agentChoice(offerFor({ harnesses: [GROK], loaded: true, rows: [], canWorktree: true }), null, null)).toBeNull();
    // A pick or an Again entry for an agent that is not installed is not taken.
    expect(agentChoice(offer, "harness:grok", null)?.key).toBe("harness:claude");
    expect(agentChoice(offer, null, again({ kind: "harness", id: "grok" }))?.key).toBe("harness:claude");
  });

  it("the Command select opens on the pick, else Again's command, else Shell", () => {
    expect(commandChoice(offer, null, null)).toEqual({ kind: "shell" });
    expect(commandChoice(offer, { kind: "row", command: "htop" }, null)).toEqual({ kind: "row", command: "htop" });
    expect(commandChoice(offer, null, again({ kind: "row", command: "htop" }))).toEqual({ kind: "row", command: "htop" });
    expect(commandChoice(offer, { kind: "row", command: "gone" }, null)).toEqual({ kind: "shell" });
    expect(commandChoice(offer, null, again({ kind: "harness", id: "claude" }))).toEqual({ kind: "shell" });
  });

  it("Start takes the Agent select in Agent, the Command select in Shell, and nothing with no agent", () => {
    const claude = agentChoice(offer, null, null);
    expect(whatFor("agent", claude, { kind: "shell" }, "")).toEqual({ kind: "harness", id: "claude" });
    expect(whatFor("shell", claude, { kind: "row", command: "htop" }, "")).toEqual({ kind: "row", command: "htop" });
    expect(whatFor("agent", null, { kind: "shell" }, "")).toBeNull();
  });

  it("opens on the remembered half, else the half Again was in, else Agent while one starts, else Shell", () => {
    expect(defaultKind(offer, true, "shell", null)).toBe("shell");
    expect(defaultKind(offer, true, null, again({ kind: "shell" }))).toBe("shell");
    expect(defaultKind(offer, true, null, again({ kind: "harness", id: "claude" }))).toBe("agent");
    expect(defaultKind(offer, true, null, null)).toBe("agent");
    const none = offerFor({ harnesses: [GROK], loaded: true, rows: [], canWorktree: true });
    expect(defaultKind(none, true, null, null)).toBe("shell");
    // The answer not being in yet is no reason to look like a machine with no agent.
    expect(defaultKind(offerFor({ harnesses: null, loaded: false, rows: [], canWorktree: true }), false, null, null)).toBe("agent");
  });

  it("a remembered choice the machine no longer has is not offered", () => {
    expect(offered(offer, { kind: "harness", id: "grok" })).toBe(false);
    expect(offered(offer, { kind: "row", command: "gone" })).toBe(false);
    expect(offered(offer, { kind: "shell" })).toBe(true);
  });

  it("a command row never starts a worktree; an agent, an agent row and the shell may", () => {
    expect(branchAllowed(offer, { kind: "row", command: "htop" })).toBe(false);
    expect(branchAllowed(offer, { kind: "harness", id: "claude" })).toBe(true);
    expect(branchAllowed(offer, { kind: "shell" })).toBe(true);
    expect(branchAllowed(offer, null)).toBe(false);
    const withItems = offerFor({ harnesses: [CLAUDE], items: ITEMS, loaded: true, rows: [], canWorktree: true });
    expect(branchAllowed(withItems, { kind: "row", command: "claude --model opus" })).toBe(true);
    expect(branchAllowed(withItems, { kind: "row", command: "make test" })).toBe(false);
  });

  it("names a choice by its label, and a choice by its half", () => {
    expect(whatLabel({ kind: "harness", id: "claude" }, offer, "Shell")).toBe("Claude Code");
    expect(whatLabel({ kind: "shell" }, offer, "Shell")).toBe("Shell");
    expect(whatLabel({ kind: "row", command: "htop" }, offer, "Shell")).toBe("htop");
    expect(kindOf({ kind: "harness", id: "claude" })).toBe("agent");
    expect(kindOf({ kind: "shell" })).toBe("shell");
    expect(kindOf({ kind: "row", command: "htop" })).toBe("shell");
    // An agent row is an agent once the offer lists it under Agents.
    const withItems = offerFor({ harnesses: [CLAUDE], items: ITEMS, loaded: true, rows: [], canWorktree: true });
    expect(kindOf({ kind: "row", command: "claude --model opus" }, withItems)).toBe("agent");
    expect(kindOf({ kind: "row", command: "make test" }, withItems)).toBe("shell");
  });
});

describe("the docs links", () => {
  it("both open the launchers section of the configure page", () => {
    expect(NEW_PAGE_DOCS.agent).toBe("https://colliepwa.dev/docs/configure#your-own-launchers");
    expect(NEW_PAGE_DOCS.command).toBe("https://colliepwa.dev/docs/configure#your-own-launchers");
  });
});

describe("the Agent-or-Shell memory", () => {
  it("keeps the half per machine and reads it back", () => {
    const store = memory();
    rememberKind("", "shell", store);
    rememberKind("mini", "agent", store);
    expect(readKind("", store)).toBe("shell");
    expect(readKind("mini", store)).toBe("agent");
    expect(readKind("other", store)).toBeNull();
    rememberKind("", "agent", store);
    expect(readKind("", store)).toBe("agent");
  });

  it("reads the word the file kept before the half was called Shell, so nobody loses their choice", () => {
    const store = memory();
    store.setItem(KIND_KEY, JSON.stringify({ "": "command", mini: "agent", odd: "nope" }));
    expect(readKind("", store)).toBe("shell");
    expect(readKind("mini", store)).toBe("agent");
    expect(readKind("odd", store)).toBeNull();
    // Writing another machine keeps the old entry, now under the new word.
    rememberKind("other", "agent", store);
    expect(JSON.parse(store.values.get(KIND_KEY) ?? "{}")).toEqual({ "": "shell", mini: "agent", other: "agent" });
  });

  it("keeps at most MAX_AGAIN machines, the oldest dropped", () => {
    const store = memory();
    for (let i = 0; i <= MAX_AGAIN; i++) rememberKind(`m${i}`, "shell", store);
    expect(readKind("m0", store)).toBeNull();
    expect(readKind(`m${MAX_AGAIN}`, store)).toBe("shell");
  });

  it("a file that is not one, a value that is not a half, or a storage that refuses reads as nothing", () => {
    const store = memory();
    store.values.set(KIND_KEY, "not json");
    expect(readKind("", store)).toBeNull();
    store.values.set(KIND_KEY, JSON.stringify({ "": "sideways" }));
    expect(readKind("", store)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => rememberKind("", "agent", broken)).not.toThrow();
    expect(readKind("", broken)).toBeNull();
  });
});

describe("summaryKey", () => {
  it("picks the sentence for the parts present", () => {
    expect(summaryKey({ what: "a", folder: "~" })).toBe("plain");
    expect(summaryKey({ what: "a", folder: "~", machine: "m" })).toBe("machine");
    expect(summaryKey({ what: "a", folder: "~", branch: { name: "b", base: "main" } })).toBe("branch");
    expect(summaryKey({ what: "a", folder: "~", machine: "m", branch: { name: "b", base: "main" } })).toBe("branchMachine");
  });
});

describe("Again", () => {
  const start = (at: number, over: Partial<LastStart> = {}): LastStart => ({
    what: { kind: "harness", id: "claude" },
    label: "Claude Code",
    cwd: "~/src/app",
    branch: null,
    at,
    ...over,
  });

  it("keeps the last start per machine and reads it back", () => {
    const store = memory();
    rememberAgain("", start(1), store);
    rememberAgain("mini", start(2, { what: { kind: "shell" }, label: "Shell", cwd: null }), store);
    expect(readAgain("", store)).toEqual(start(1));
    expect(readAgain("mini", store)?.what).toEqual({ kind: "shell" });
    expect(readAgain("other", store)).toBeNull();
  });

  it("keeps a branch start's folder kind", () => {
    const store = memory();
    rememberAgain("", start(1, { branch: { folder: { kind: "parent", parent: "~/trees" } } }), store);
    expect(readAgain("", store)?.branch).toEqual({ folder: { kind: "parent", parent: "~/trees" } });
  });

  it("keeps at most MAX_AGAIN machines, the oldest dropped", () => {
    const store = memory();
    for (let i = 0; i <= MAX_AGAIN; i++) rememberAgain(`m${i}`, start(i), store);
    expect(readAgain("m0", store)).toBeNull();
    expect(readAgain(`m${MAX_AGAIN}`, store)).not.toBeNull();
  });

  it("a file that is not one, or an entry that is not a start, reads as nothing", () => {
    const store = memory();
    store.values.set(AGAIN_KEY, "not json");
    expect(readAgain("", store)).toBeNull();
    store.values.set(AGAIN_KEY, JSON.stringify({ "": { what: { kind: "harness" }, label: "x", cwd: null, at: 1, branch: null } }));
    expect(readAgain("", store)).toBeNull();
  });

  it("a storage that refuses keeps no memory and throws nothing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => rememberAgain("", start(1), broken)).not.toThrow();
    expect(readAgain("", broken)).toBeNull();
  });
});

describe("Again for a one-off line", () => {
  it("keeps the line and its folder, and reads them back as a run", () => {
    const store = memory();
    rememberAgain("", { what: { kind: "run", line: "make deploy" }, label: "make deploy", cwd: "/srv/app", branch: null, at: 1 }, store);
    expect(readAgain("", store)).toEqual({ what: { kind: "run", line: "make deploy" }, label: "make deploy", cwd: "/srv/app", branch: null, at: 1 });
  });

  it("an entry with a run kind and no line is not a start", () => {
    const store = memory();
    store.values.set(AGAIN_KEY, JSON.stringify({ "": { what: { kind: "run" }, label: "x", cwd: null, at: 1, branch: null } }));
    expect(readAgain("", store)).toBeNull();
  });
});

describe("startFingerprint", () => {
  const ask = { machine: "", what: { kind: "harness", id: "claude" } as const, cwd: "~/a", branch: null };

  it("is the same for the same ask, so a retry keeps its request id", () => {
    expect(startFingerprint(ask)).toBe(startFingerprint({ ...ask }));
  });

  it("changes with any part of the ask, so a changed retry gets a new id", () => {
    const one = startFingerprint(ask);
    expect(startFingerprint({ ...ask, machine: "mini" })).not.toBe(one);
    expect(startFingerprint({ ...ask, cwd: "~/b" })).not.toBe(one);
    expect(startFingerprint({ ...ask, what: { kind: "shell" } })).not.toBe(one);
    // A one-off line is part of the ask: editing the line mints a new request id.
    const run = { ...ask, what: { kind: "run", line: "htop" } } as const;
    expect(startFingerprint(run)).toBe(startFingerprint({ ...run }));
    expect(startFingerprint({ ...run, what: { kind: "run", line: "htop -d 5" } })).not.toBe(startFingerprint(run));
    expect(
      startFingerprint({ ...ask, branch: { name: "x", base: "main", folder: { kind: "default" } } }),
    ).not.toBe(one);
  });
});

describe("folderShown", () => {
  it("is home for nothing, the path itself for ~ and absolute paths, and a folder under home for a bare name", () => {
    expect(folderShown("", "/home/op")).toBe("/home/op");
    expect(folderShown("  ", "")).toBe("~");
    expect(folderShown("~", "/home/op")).toBe("~");
    expect(folderShown("~/src/app", "/home/op")).toBe("~/src/app");
    expect(folderShown("/srv/www", "/home/op")).toBe("/srv/www");
    expect(folderShown("projects", "/home/op")).toBe("~/projects");
    expect(folderShown("./projects/app ", "/home/op")).toBe("~/projects/app");
  });
});
