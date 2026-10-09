import {
  AGAIN_KEY,
  KIND_KEY,
  MAX_AGAIN,
  NEW_PAGE_DOCS,
  agentChoice,
  branchAllowed,
  commandChoice,
  defaultKind,
  folderShown,
  kindOf,
  machineWord,
  offerFor,
  offered,
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
import type { HarnessInfo, Launcher, ServerSummary } from "./types";

// The New page's rules (M48 spec 01): what is offered and what is listed as not working, the summary's
// sentence, the Again and Agent-or-Command memories, and when a retry may keep its request id.

const CLAUDE: HarnessInfo = { id: "claude", label: "Claude Code", found: true };
const GROK: HarnessInfo = { id: "grok", label: "Grok", found: false };
const HTOP: Launcher = { command: "htop", label: "htop" };

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
    expect(offer.agents).toEqual([
      { id: "claude", label: "Claude Code", unavailable: null },
      { id: "grok", label: "Grok", unavailable: { kind: "notFound" } },
    ]);
    expect(startableAgents(offer).map((a) => a.id)).toEqual(["claude"]);
    expect(offer.rows).toEqual([HTOP]);
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
    expect(offer.rows).toEqual([]);
    expect(offer.branchBlocked).toEqual({ kind: "machine", sentence: "minibuch is not reachable" });
  });
});

describe("unavailableText", () => {
  it("says each reason in words short enough for brackets", () => {
    expect(unavailableText({ kind: "notFound" })).toBe("not installed");
    expect(unavailableText({ kind: "needsHerdr" })).toBe("needs Herdr");
    expect(unavailableText({ kind: "onlyOnLead", lead: "bluefin" })).toBe("only on bluefin");
    expect(unavailableText({ kind: "olderCollie" })).toMatch(/older Collie/);
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
    expect(agentChoice(offer, null, null)).toBe("claude");
    expect(agentChoice(offer, "claude", null)).toBe("claude");
    expect(agentChoice(offerFor({ harnesses: [GROK], loaded: true, rows: [], canWorktree: true }), null, null)).toBeNull();
    // A pick or an Again entry for an agent that is not installed is not taken.
    expect(agentChoice(offer, "grok", null)).toBe("claude");
    expect(agentChoice(offer, null, again({ kind: "harness", id: "grok" }))).toBe("claude");
  });

  it("the Command select opens on the pick, else Again's command, else Shell", () => {
    expect(commandChoice(offer, null, null)).toEqual({ kind: "shell" });
    expect(commandChoice(offer, { kind: "row", command: "htop" }, null)).toEqual({ kind: "row", command: "htop" });
    expect(commandChoice(offer, null, again({ kind: "row", command: "htop" }))).toEqual({ kind: "row", command: "htop" });
    expect(commandChoice(offer, { kind: "row", command: "gone" }, null)).toEqual({ kind: "shell" });
    expect(commandChoice(offer, null, again({ kind: "harness", id: "claude" }))).toEqual({ kind: "shell" });
  });

  it("Start takes the Agent select in Agent, the Command select in Command, and nothing with no agent", () => {
    expect(whatFor("agent", "claude", { kind: "shell" })).toEqual({ kind: "harness", id: "claude" });
    expect(whatFor("command", "claude", { kind: "row", command: "htop" })).toEqual({ kind: "row", command: "htop" });
    expect(whatFor("agent", null, { kind: "shell" })).toBeNull();
  });

  it("opens on the remembered half, else the half Again was in, else Agent while one starts, else Command", () => {
    expect(defaultKind(offer, true, "command", null)).toBe("command");
    expect(defaultKind(offer, true, null, again({ kind: "shell" }))).toBe("command");
    expect(defaultKind(offer, true, null, again({ kind: "harness", id: "claude" }))).toBe("agent");
    expect(defaultKind(offer, true, null, null)).toBe("agent");
    const none = offerFor({ harnesses: [GROK], loaded: true, rows: [], canWorktree: true });
    expect(defaultKind(none, true, null, null)).toBe("command");
    // The answer not being in yet is no reason to look like a machine with no agent.
    expect(defaultKind(offerFor({ harnesses: null, loaded: false, rows: [], canWorktree: true }), false, null, null)).toBe("agent");
  });

  it("a remembered choice the machine no longer has is not offered", () => {
    expect(offered(offer, { kind: "harness", id: "grok" })).toBe(false);
    expect(offered(offer, { kind: "row", command: "gone" })).toBe(false);
    expect(offered(offer, { kind: "shell" })).toBe(true);
  });

  it("a row never starts a worktree; an agent and the shell may", () => {
    expect(branchAllowed({ kind: "row", command: "htop" })).toBe(false);
    expect(branchAllowed({ kind: "harness", id: "claude" })).toBe(true);
    expect(branchAllowed({ kind: "shell" })).toBe(true);
    expect(branchAllowed(null)).toBe(false);
  });

  it("names a choice by its label, and a choice by its half", () => {
    expect(whatLabel({ kind: "harness", id: "claude" }, offer, "Shell")).toBe("Claude Code");
    expect(whatLabel({ kind: "shell" }, offer, "Shell")).toBe("Shell");
    expect(whatLabel({ kind: "row", command: "htop" }, offer, "Shell")).toBe("htop");
    expect(kindOf({ kind: "harness", id: "claude" })).toBe("agent");
    expect(kindOf({ kind: "shell" })).toBe("command");
    expect(kindOf({ kind: "row", command: "htop" })).toBe("command");
  });
});

describe("the docs links", () => {
  it("both open the launchers section of the configure page", () => {
    expect(NEW_PAGE_DOCS.agent).toBe("https://colliepwa.dev/docs/configure#your-own-launchers");
    expect(NEW_PAGE_DOCS.command).toBe("https://colliepwa.dev/docs/configure#your-own-launchers");
  });
});

describe("the Agent-or-Command memory", () => {
  it("keeps the half per machine and reads it back", () => {
    const store = memory();
    rememberKind("", "command", store);
    rememberKind("mini", "agent", store);
    expect(readKind("", store)).toBe("command");
    expect(readKind("mini", store)).toBe("agent");
    expect(readKind("other", store)).toBeNull();
    rememberKind("", "agent", store);
    expect(readKind("", store)).toBe("agent");
  });

  it("keeps at most MAX_AGAIN machines, the oldest dropped", () => {
    const store = memory();
    for (let i = 0; i <= MAX_AGAIN; i++) rememberKind(`m${i}`, "command", store);
    expect(readKind("m0", store)).toBeNull();
    expect(readKind(`m${MAX_AGAIN}`, store)).toBe("command");
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
