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
  ...(host ? { host } : {}),
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
