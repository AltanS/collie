import {
  ambientHost,
  countsFor,
  findPane,
  hostCounts,
  hostKey,
  hostName,
  hostSlot,
  HOST_SLOT_COUNT,
  isMultiHost,
  leadHost,
  ambientPanes,
  ambientSpaces,
  paneRowKey,
  paneScope,
  paneSpaceKey,
  primarySession,
  serverFor,
  sessionsOnHost,
  spaceKey,
} from "./hosts";
import type { AgentView, ServerSummary } from "./types";

const lead: ServerSummary = {
  id: "bluefin",
  name: "bluefin",
  isLead: true,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 10,
};
const peer: ServerSummary = {
  id: "workshop",
  name: "workshop",
  isLead: false,
  reachable: false,
  protocol: "ok",
  lastSeenAt: 5,
};
const pack = [lead, peer];

const pane = (paneId: string, host?: string, status: AgentView["status"] = "idle"): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "ws",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status,
  cwd: "/home/you/ws",
  focused: false,
  host, // optional and undefined-when-absent: the same thing to every reader of an AgentView
});

describe("the solo answer is the default answer", () => {
  it("reads an absent roster as 'no pack' everywhere", () => {
    expect(isMultiHost(undefined)).toBe(false);
    expect(isMultiHost([])).toBe(false);
    // A lead with zero enrolled peers is still one machine — nothing to choose, nothing to label.
    expect(isMultiHost([lead])).toBe(false);
    expect(leadHost(undefined)).toBeUndefined();
    expect(ambientHost(undefined, undefined)).toBeUndefined();
    expect(hostName(undefined, undefined)).toBeUndefined();
  });

  it("keys an untagged pane exactly as a bare workspace id, one separator deep", () => {
    expect(hostKey(undefined)).toBe("");
    expect(hostKey({})).toBe("");
    expect(paneSpaceKey({ workspaceId: "w1" })).toBe(spaceKey(undefined, "w1"));
    expect(spaceKey(undefined, "w1")).not.toBe(spaceKey("bluefin", "w1"));
  });
});

describe("resolving a host", () => {
  it("treats an absent host as the lead, the same way `?h=` does", () => {
    expect(serverFor(pack, undefined)).toBe(lead);
    expect(ambientHost(pack, undefined)).toBe("bluefin");
    expect(ambientHost(pack, "workshop")).toBe("workshop");
  });

  it("renders an unlisted host as itself rather than relabelling or dropping it", () => {
    // A member that departed while you were looking at it must not be silently rewritten to the lead.
    expect(hostName(pack, "gone")).toBe("gone");
    expect(serverFor(pack, "gone")).toBeUndefined();
  });
});

describe("paneScope — a row is opened with its OWN host", () => {
  it("carries a peer's host onto the navigation, keeping the session", () => {
    expect(paneScope({ session: "demo" }, pane("w1:p1", "workshop"), pack)).toEqual({
      host: "workshop",
      session: "demo",
    });
  });

  it("normalises the lead's own id back to an absent host — today's bare URL", () => {
    expect(paneScope({}, pane("w1:p1", "bluefin"), pack)).toEqual({ host: undefined, session: undefined });
  });

  it("leaves an untagged (solo) pane's scope untouched, by identity", () => {
    const scope = { session: "demo" };
    expect(paneScope(scope, pane("w1:p1"), undefined)).toBe(scope);
    expect(paneScope(scope, undefined, undefined)).toBe(scope);
  });
});

describe("findPane — the same id on two machines is two terminals", () => {
  const panes = [pane("w1:p1", "bluefin"), pane("w1:p1", "workshop", "blocked")];

  it("finds the pane on the scope's host, not the first id match", () => {
    expect(findPane(panes, "w1:p1", { host: "workshop" }, pack)!.status).toBe("blocked");
    expect(findPane(panes, "w1:p1", {}, pack)!.status).toBe("idle");
  });

  it("matches untagged panes under any scope (the solo lookup, unchanged)", () => {
    expect(findPane([pane("w1:p1")], "w1:p1", { host: "workshop" }, undefined)).toBeDefined();
  });

  it("returns undefined for a host that holds no such pane", () => {
    expect(findPane(panes, "w9:p9", { host: "workshop" }, pack)).toBeUndefined();
  });
});

// ── The SESSION dimension of the same address ────────────────────────────────
//
// A pane id is unique only within one session on one machine: every named Herdr session is its own
// server. So `w1:p1` in `work` and `w1:p1` in the primary session are two different terminals, on one
// machine, with byte-identical ids — the pack bug one dimension down. A pane names its session only
// on a WIDENED body (`?all=1`), which is the only list that ever holds both at once.
const inSession = (p: AgentView, session: string): AgentView => ({ ...p, session });

const registry = [
  { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
  { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
];

describe("primarySession", () => {
  it("names the session an absent `?s=` means", () => {
    expect(primarySession(registry)).toBe("default");
  });

  it("says nothing rather than guessing when the bridge listed none", () => {
    // A guess here would be a lookup that silently finds nothing, and a url that names the wrong
    // session. Undefined makes both normalisation and matching no-ops instead.
    expect(primarySession(undefined)).toBeUndefined();
    expect(primarySession([])).toBeUndefined();
  });
});

describe("findPane — the same id in two sessions is two terminals too", () => {
  const widened = [
    inSession(pane("w1:p1"), "default"),
    inSession(pane("w1:p1", undefined, "blocked"), "work"),
  ];

  it("finds the pane in the scope's session, not the first id match", () => {
    expect(findPane(widened, "w1:p1", { session: "work" }, undefined, registry)!.status).toBe(
      "blocked",
    );
    // An absent `?s=` IS the primary session, and a tagged pane spells that name out — so the two
    // have to be resolved against each other or the primary row becomes unreachable.
    expect(findPane(widened, "w1:p1", {}, undefined, registry)!.status).toBe("idle");
  });

  it("matches untagged panes under any scope — the un-widened lookup, unchanged", () => {
    expect(findPane([pane("w1:p1")], "w1:p1", { session: "work" }, undefined, registry)).toBeDefined();
    expect(findPane([pane("w1:p1")], "w1:p1", {}, undefined)).toBeDefined();
  });

  it("skips the session test entirely when no registry was passed", () => {
    // The only body with no session list is a body in which no pane can be tagged, so this is not a
    // hole — it is the old signature continuing to mean what it meant.
    expect(findPane(widened, "w1:p1", { session: "work" }, undefined)).toBeDefined();
  });

  it("still separates by host, and by both at once", () => {
    const both = [
      inSession(pane("w1:p1", "bluefin"), "default"),
      inSession(pane("w1:p1", "bluefin", "blocked"), "work"),
      inSession(pane("w1:p1", "workshop", "working"), "work"),
    ];
    expect(findPane(both, "w1:p1", { host: "workshop", session: "work" }, pack, registry)!.status).toBe(
      "working",
    );
    expect(findPane(both, "w1:p1", { session: "work" }, pack, registry)!.status).toBe("blocked");
  });
});

describe("paneScope — a row is opened with its OWN session", () => {
  it("carries a named session onto the navigation, over the ambient one", () => {
    // THE GUARD. The widened list holds panes from several sessions; opening one with the ambient
    // session would point every read, key press and reply at the identically-numbered pane in
    // whichever session the url happened to be on.
    expect(
      paneScope({ session: "other" }, inSession(pane("w1:p1"), "work"), undefined, registry),
    ).toEqual({ host: undefined, session: "work" });
  });

  it("normalises the PRIMARY session back to an absent one — today's bare URL", () => {
    // A row opened from the widened list must produce the same url it would have produced from the
    // narrow one. You cannot tell from a pane url which view you came from, which is exactly what
    // keeps the breadth out of the address.
    expect(paneScope({}, inSession(pane("w1:p1"), "default"), undefined, registry)).toEqual({
      host: undefined,
      session: undefined,
    });
  });

  it("leaves a named session spelled out when it cannot know which is primary", () => {
    // An un-normalised name still addresses the right session — it just says so in the url. That is
    // strictly better than guessing, which would address the wrong one.
    expect(paneScope({}, inSession(pane("w1:p1"), "default"), undefined)).toEqual({
      host: undefined,
      session: "default",
    });
  });

  it("resolves both halves from the pane at once", () => {
    expect(
      paneScope({ session: "other" }, inSession(pane("w1:p1", "workshop"), "work"), pack, registry),
    ).toEqual({ host: "workshop", session: "work" });
  });
});

// A MERGED registry holds one primary PER MACHINE — two rows both saying `isPrimary`, which is the
// same "two defaults, indistinguishable" problem the session switcher already lists per host to
// avoid. Anything comparing a row's session against "the primary" has to say WHICH machine's.
describe("the primary is resolved per machine, never flatly", () => {
  const merged = [
    { name: "default", host: "bluefin", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
    { name: "work", host: "bluefin", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
    { name: "main", host: "workshop", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
  ];

  it("normalises a peer row's own primary away, not the lead's", () => {
    // `main` is primary on workshop, so a workshop row in it produces today's bare url. Asking the
    // merged registry flatly would have compared it against `default` and spelled it out instead.
    const peerPane = { ...inSession(pane("w1:p1", "workshop"), "main") };
    expect(paneScope({}, peerPane, pack, merged)).toEqual({ host: "workshop", session: undefined });
  });

  it("does NOT normalise a name that is only primary on the OTHER machine", () => {
    // The dangerous direction: dropping `?s=default` from a workshop row would address workshop's
    // `main` instead — a different machine's different terminal, through a url that looks ordinary.
    const peerPane = { ...inSession(pane("w1:p1", "workshop"), "default") };
    expect(paneScope({}, peerPane, pack, merged)).toEqual({ host: "workshop", session: "default" });
  });

  it("resolves the lookup's own primary per host too", () => {
    const panes = [
      inSession(pane("w1:p1", "bluefin"), "default"),
      inSession(pane("w1:p1", "workshop"), "main"),
    ];
    // An absent `?s=` on workshop means `main`, not `default`.
    expect(findPane(panes, "w1:p1", { host: "workshop" }, pack, merged)).toBeDefined();
    expect(findPane(panes, "w1:p1", {}, pack, merged)!.host).toBe("bluefin");
  });
});

describe("sessionsOnHost", () => {
  it("lists only the current host's sessions, so two 'default's can't be confused", () => {
    const sessions = [
      { name: "default", host: "bluefin" },
      { name: "demo", host: "bluefin" },
      { name: "default", host: "workshop" },
    ];
    expect(sessionsOnHost(sessions, {}, pack).map((s) => s.name)).toEqual(["default", "demo"]);
    expect(sessionsOnHost(sessions, { host: "workshop" }, pack)).toHaveLength(1);
  });

  it("passes untagged sessions through untouched (solo)", () => {
    const sessions: { name: string; host?: string }[] = [{ name: "default" }, { name: "demo" }];
    expect(sessionsOnHost(sessions, {}, undefined)).toHaveLength(2);
  });
});

describe("hostCounts", () => {
  it("counts per host in one pass over the merged rows", () => {
    const counts = hostCounts([
      pane("w1:p1", "bluefin", "working"),
      pane("w2:p1", "workshop", "blocked"),
      pane("w3:p1", "workshop", "blocked"),
      pane("w4:p1", "workshop", "idle"),
    ]);
    expect(countsFor(counts, "bluefin")).toEqual({ agents: 1, working: 1, blocked: 0 });
    expect(countsFor(counts, "workshop")).toEqual({ agents: 3, working: 0, blocked: 2 });
    expect(countsFor(counts, "nobody")).toEqual({ agents: 0, working: 0, blocked: 0 });
  });
});

// ── A ROW'S IDENTITY ─────────────────────────────────────────────────────────
//
// This is a React `key`, and on this list a React key is a safety property. A pane id is unique only
// within one session on one machine, so a merged or widened list holds several rows answering to
// `w1:p1`. Keyed by the id alone React recycles one row's element for another's between polls: the
// card keeps its position and acquires a different row's `onClick` — a tap landing in another
// terminal, on the list whose whole purpose is "tap the thing that needs you".
describe("paneRowKey", () => {
  it("separates the same id across sessions and across machines", () => {
    const keys = [
      paneRowKey(inSession(pane("w1:p1"), "default")),
      paneRowKey(inSession(pane("w1:p1"), "work")),
      paneRowKey(inSession(pane("w1:p1", "workshop"), "default")),
      paneRowKey(pane("w1:p1", "workshop")),
      paneRowKey(pane("w1:p1")),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("degrades to a pure prefix of the bare id when nothing is tagged", () => {
    // A solo, un-widened list keys exactly as it always did — no re-mount on the upgrade.
    expect(paneRowKey(pane("w1:p1"))).toBe("\u0000\u0000w1:p1");
  });
});

// ── THE NAVIGATION TREE STAYS AMBIENT ────────────────────────────────────────
//
// The triage lists are what widening is for. The space navigator is a TREE, and its keys carry a
// host and no session — Herdr workspace ids collide across sessions exactly as they collide across
// machines. Fed a widened body it would paint another session's blocked dot onto the ambient space
// of the same number, and drilling in would show a space with nothing blocked in it.
describe("ambientPanes", () => {
  const widened = [
    inSession(pane("w1:p1"), "default"),
    inSession(pane("w1:p2", undefined, "blocked"), "work"),
  ];

  it("drops the panes belonging to another session", () => {
    const out = ambientPanes(widened, [], {}, undefined, registry);
    expect(out.agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  it("keeps the named session's panes when the url names it", () => {
    const out = ambientPanes(widened, [], { session: "work" }, undefined, registry);
    expect(out.agents.map((p) => p.paneId)).toEqual(["w1:p2"]);
  });

  it("returns an un-widened body BY IDENTITY, not as a copy", () => {
    // Untagged is ambient by definition, so a solo install's render is what it always was — and
    // that has to include the allocation. This result is memoised into the space navigator's props
    // and recomputed on every poll; a fresh array per tick would re-render the navigator on every
    // poll of every dashboard that exists today.
    const plain = [pane("w1:p1"), pane("w1:p2")];
    const out = ambientPanes(plain, [], { session: "work" }, undefined, registry);
    expect(out.agents).toBe(plain);
  });

  it("filters shell panes on the same rule", () => {
    const out = ambientPanes([], widened, {}, undefined, registry);
    expect(out.shellPanes.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  it("narrows by host as well, so a peer's spaces never reach the lead's tree", () => {
    const mixed = [pane("w1:p1", "bluefin"), pane("w1:p1", "workshop")];
    const out = ambientPanes(mixed, [], {}, pack, registry);
    expect(out.agents.map((p) => p.host)).toEqual(["bluefin"]);
  });
});

// The rows those panes are drawn against. The lead's merge host-tags `workspaces` and `tabs` now
// (F14) — before that a peer's space had no row at all, and every count on the lead's `w1` was the
// lead's own. Tagged, they collide no more; narrowed, the tree still describes ONE machine.
describe("ambientSpaces", () => {
  const spaces = [
    { workspaceId: "w1", host: "bluefin" },
    { workspaceId: "w1", host: "workshop" },
    { workspaceId: "w2", host: "workshop" },
  ];

  it("keeps only the rows on the host the url is pointed at", () => {
    expect(ambientSpaces(spaces, {}, pack).map((w) => w.host)).toEqual(["bluefin"]);
    expect(ambientSpaces(spaces, { host: "workshop" }, pack).map((w) => w.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("returns a solo body BY IDENTITY, not as a copy", () => {
    // No row carries a host, so everything passes — and the allocation has to stay absent too: this
    // runs on every poll and its result feeds the navigator's props.
    const plain: { workspaceId: string; host?: string }[] = [{ workspaceId: "w1" }, { workspaceId: "w2" }];
    expect(ambientSpaces(plain, {}, undefined)).toBe(plain);
  });

  it("an untagged row is ambient, so a mixed body cannot lose the lead's own spaces", () => {
    const mixed: { workspaceId: string; host?: string }[] = [
      { workspaceId: "w1" },
      { workspaceId: "w1", host: "workshop" },
    ];
    expect(ambientSpaces(mixed, {}, pack)).toEqual([{ workspaceId: "w1" }]);
  });
});

// ── The per-host colour ──────────────────────────────────────────────────────────────────────────
//
// The claim under test is not "it returns a number". It is that the number is the SAME number
// tomorrow, that no two machines in a normal pack share one, and that a solo collie gets none at
// all — a colour that moves is worse than no colour, because the operator has already learned it.
describe("hostSlot", () => {
  const server = (id: string, isLead = false): ServerSummary => ({
    id,
    name: id,
    isLead,
    reachable: true,
    protocol: "ok",
    lastSeenAt: 10,
  });
  const roster = (...ids: string[]): ServerSummary[] => ids.map((id, i) => server(id, i === 0));

  it("gives a solo collie no colour at all — the feature only exists to tell machines apart", () => {
    expect(hostSlot(undefined, "bluefin")).toBeNull();
    expect(hostSlot([], "bluefin")).toBeNull();
    expect(hostSlot(roster("bluefin"), "bluefin")).toBeNull();
  });

  it("resolves an absent host to the lead, exactly as the rest of the module does", () => {
    const pack5 = roster("bluefin", "workshop", "attic");
    expect(hostSlot(pack5, undefined)).toBe(hostSlot(pack5, "bluefin"));
  });

  it("gives no colour when there is no lead to resolve an absent host to", () => {
    const leaderless = ["a", "b"].map((id) => server(id));
    expect(hostSlot(leaderless, undefined)).toBeNull();
  });

  it("gives no colour to a host the roster does not list — a departed member keeps its NAME only", () => {
    expect(hostSlot(roster("bluefin", "workshop"), "departed")).toBeNull();
  });

  it("is stable: the same set of ids yields the same slot, whatever order they arrive in", () => {
    const a = roster("bluefin", "workshop", "attic", "cellar", "garage");
    const b = roster("garage", "cellar", "attic", "workshop", "bluefin");
    for (const id of ["bluefin", "workshop", "attic", "cellar", "garage"]) {
      expect(hostSlot(b, id)).toBe(hostSlot(a, id));
    }
  });

  it("holds a machine's colour when an UNRELATED machine joins or leaves", () => {
    // The whole point of hashing rather than indexing: enrolling a machine whose id sorts first
    // would re-colour the pack under an operator who has already learned it.
    const before = roster("bluefin", "workshop", "attic");
    const after = roster("bluefin", "workshop", "attic", "zebra");
    expect(hostSlot(after, "bluefin")).toBe(hostSlot(before, "bluefin"));
    expect(hostSlot(after, "workshop")).toBe(hostSlot(before, "workshop"));
    expect(hostSlot(after, "attic")).toBe(hostSlot(before, "attic"));
  });

  it("never hands two machines the same slot while the roster fits the palette", () => {
    const ids = ["bluefin", "workshop", "attic", "cellar", "garage", "loft", "shed", "barn", "kennel", "porch"];
    for (let n = 2; n <= HOST_SLOT_COUNT; n += 1) {
      const some = roster(...ids.slice(0, n));
      const slots = ids.slice(0, n).map((id) => hostSlot(some, id));
      expect(slots).not.toContain(null);
      expect(new Set(slots).size).toBe(n);
    }
  });

  it("wraps past ten machines rather than inventing an eleventh colour", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `machine-${i}`);
    const big = roster(...ids);
    const slots = ids.map((id) => hostSlot(big, id));
    for (const slot of slots) {
      expect(slot).not.toBeNull();
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(HOST_SLOT_COUNT);
    }
    // Every colour is spoken for, and the surplus machines double up — the NAME is the answer then,
    // as it was before any of this existed.
    expect(new Set(slots).size).toBe(HOST_SLOT_COUNT);
  });
});
