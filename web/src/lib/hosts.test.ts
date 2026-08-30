import {
  ambientHost,
  countsFor,
  findPane,
  hostCounts,
  hostKey,
  hostName,
  isMultiHost,
  leadHost,
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
