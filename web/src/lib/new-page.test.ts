import {
  AGAIN_KEY,
  KIND_KEY,
  MAX_AGAIN,
  NEW_PAGE_DOCS,
  agentChoice,
  branchAllowed,
  commandChoice,
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
  readAgain,
  readKind,
  rememberAgain,
  rememberKind,
  startFingerprint,
  startableAgents,
  summaryKey,
  unavailableText,
  whatFor,
  whatLabel,
  type LastStart,
} from "./new-page";
import { hostHealth } from "./host-health";
import type { HarnessInfo, Launcher, LauncherItem, ServerSummary } from "./types";

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
      { key: "shell", text: "Just a shell", disabled: false },
      { key: "row:make test", text: "make test", disabled: false },
      { key: "row:htop --typed", text: "typed (typed lines are turned off on this machine)", disabled: true },
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
    expect(whatFor("agent", claude, { kind: "shell" })).toEqual({ kind: "harness", id: "claude" });
    expect(whatFor("shell", claude, { kind: "row", command: "htop" })).toEqual({ kind: "row", command: "htop" });
    expect(whatFor("agent", null, { kind: "shell" })).toBeNull();
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
