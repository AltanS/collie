import {
  AGAIN_KEY,
  MAX_AGAIN,
  branchAllowed,
  firstWhat,
  offerFor,
  offered,
  readAgain,
  rememberAgain,
  startFingerprint,
  summaryKey,
  whatLabel,
  type LastStart,
} from "./new-sheet";
import type { HarnessInfo, Launcher } from "./types";

// The New sheet's rules (M48 spec 01): what is offered and what goes to the top block, the summary's
// sentence, the Again memory, and when a retry may keep its request id.

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

  it("offers the agents found, lists the rest at the top with their reason, never hides one", () => {
    const offer = offerFor(base);
    expect(offer.agents).toEqual([CLAUDE]);
    expect(offer.rows).toEqual([HTOP]);
    expect(offer.branch).toBe(true);
    expect(offer.off).toEqual([{ key: "harness:grok", label: "Grok", group: "agents", reason: { kind: "notFound" } }]);
  });

  it("an older Collie: no agents, one line that says why, no branches, the shell by the old route", () => {
    const offer = offerFor({ ...base, harnesses: null });
    expect(offer.agents).toEqual([]);
    expect(offer.shellById).toBe(false);
    expect(offer.branch).toBe(false);
    expect(offer.off.map((o) => o.reason.kind)).toEqual(["olderCollie"]);
  });

  it("an answer not in yet is not an older Collie", () => {
    const offer = offerFor({ ...base, harnesses: null, loaded: false });
    expect(offer.off).toEqual([]);
  });

  it("no worktrees: the branch line says it needs Herdr; a member: only on the lead", () => {
    expect(offerFor({ ...base, canWorktree: false }).off.at(-1)?.reason).toEqual({ kind: "needsHerdr" });
    const member = offerFor({ ...base, memberChosen: { lead: "bluefin" } });
    expect(member.branch).toBe(false);
    expect(member.off.at(-1)?.reason).toEqual({ kind: "onlyOnLead", lead: "bluefin" });
  });

  it("a machine that takes no writes is the one line, and nothing is offered", () => {
    const offer = offerFor({ ...base, refusal: "minibuch is not reachable" });
    expect(offer.agents).toEqual([]);
    expect(offer.rows).toEqual([]);
    expect(offer.off).toEqual([
      { key: "machine", label: null, group: "machine", reason: { kind: "machine", sentence: "minibuch is not reachable" } },
    ]);
  });
});

describe("the choice", () => {
  const offer = offerFor({ harnesses: [CLAUDE, GROK], loaded: true, rows: [HTOP], canWorktree: true });

  it("opens on the first agent found, else the shell", () => {
    expect(firstWhat(offer)).toEqual({ kind: "harness", id: "claude" });
    expect(firstWhat(offerFor({ harnesses: [GROK], loaded: true, rows: [], canWorktree: true }))).toEqual({ kind: "shell" });
  });

  it("a remembered choice the machine no longer has is not offered", () => {
    expect(offered(offer, { kind: "harness", id: "grok" })).toBe(false);
    expect(offered(offer, { kind: "row", command: "gone" })).toBe(false);
    expect(offered(offer, { kind: "shell" })).toBe(true);
  });

  it("a row never starts on a branch; an agent and the shell may", () => {
    expect(branchAllowed({ kind: "row", command: "htop" })).toBe(false);
    expect(branchAllowed({ kind: "harness", id: "claude" })).toBe(true);
    expect(branchAllowed({ kind: "shell" })).toBe(true);
    expect(branchAllowed(null)).toBe(false);
  });

  it("names a choice by its label", () => {
    expect(whatLabel({ kind: "harness", id: "claude" }, offer, "Shell")).toBe("Claude Code");
    expect(whatLabel({ kind: "shell" }, offer, "Shell")).toBe("Shell");
    expect(whatLabel({ kind: "row", command: "htop" }, offer, "Shell")).toBe("htop");
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
