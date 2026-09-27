import {
  folderName,
  foldersInUse,
  hasFolders,
  MAX_OPEN_NOW,
  NO_FOLDERS,
  openNowRows,
  visibleFolders,
} from "./folders";
import type { AgentView, ServerSummary } from "./types";

// The pure half of the new-space sheet's folder list (#289). The read, the star and the sheet around
// them are driven in components/new-space-sheet.test.tsx.

describe("folderName — the name a row leads with", () => {
  it("is the last segment", () => {
    expect(folderName("/home/you/src/web")).toBe("web");
    expect(folderName("/srv/api/")).toBe("api");
    expect(folderName("relative")).toBe("relative");
  });

  it("the root names itself", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("visibleFolders — home is never drawn", () => {
  it("drops home from both lists, however either side spells the trailing slash", () => {
    const out = visibleFolders({
      recent: ["/home/you", "/home/you/a"],
      favourites: ["/home/you/", "/srv/b"],
      home: "/home/you/",
    });
    expect(out).toEqual({ recent: ["/home/you/a"], favourites: ["/srv/b"], home: "/home/you/" });
  });

  it("keeps a folder that merely shares home as a prefix", () => {
    expect(visibleFolders({ recent: ["/home/youth"], favourites: [], home: "/home/you" }).recent).toEqual([
      "/home/youth",
    ]);
  });

  it("drops nothing when the machine did not say where home is", () => {
    expect(visibleFolders({ recent: ["/home/you"], favourites: [], home: "" }).recent).toEqual(["/home/you"]);
  });
});

describe("hasFolders", () => {
  it("is false for an empty list and true when either list has a row", () => {
    expect(hasFolders(NO_FOLDERS)).toBe(false);
    expect(hasFolders({ recent: ["/a"], favourites: [], home: "" })).toBe(true);
    expect(hasFolders({ recent: [], favourites: ["/a"], home: "" })).toBe(true);
  });
});

// ── Open now (#289, option B2) ───────────────────────────────────────────────────────────────────

/** A pane with only what Open now reads, the rest filled in the way the fixtures fill it. */
function pane(over: Partial<AgentView> & Pick<AgentView, "paneId" | "cwd">): AgentView {
  const workspaceId = over.paneId.split(":")[0]!;
  return {
    workspaceId,
    workspaceLabel: workspaceId,
    workspaceNumber: Number(workspaceId.slice(1)),
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    status: "idle",
    focused: false,
    ...over,
  };
}

const lead: ServerSummary = { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 };
const peer: ServerSummary = { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 };

describe("foldersInUse — the folders one machine's panes sit in now", () => {
  it("runs in the dashboard's place order, agents and shells, each folder once", () => {
    const panes = {
      // Handed over out of order: workspace 2 first, and a shell ahead of the agents.
      agents: [
        pane({ paneId: "w2:p1", cwd: "/srv/two" }),
        pane({ paneId: "w1:p2", cwd: "/srv/one-b", tabPosition: 1 }),
        pane({ paneId: "w1:p1", cwd: "/srv/one-a", tabPosition: 0 }),
      ],
      shellPanes: [pane({ paneId: "w1:p3", cwd: "/srv/one-a/", kind: "shell", tabPosition: 2 }), pane({ paneId: "w3:p1", cwd: "/srv/three", kind: "shell" })],
    };
    expect(foldersInUse(panes, undefined, [])).toEqual(["/srv/one-a", "/srv/one-b", "/srv/two", "/srv/three"]);
  });

  it("keeps only the chosen machine's panes; an untagged pane is the lead's", () => {
    const panes = {
      agents: [
        pane({ paneId: "w1:p1", cwd: "/home/you/lead", host: "bluefin" }),
        pane({ paneId: "w1:p1", cwd: "/home/w/peer", host: "workshop" }),
        pane({ paneId: "w2:p1", cwd: "/home/you/untagged" }),
      ],
      shellPanes: [],
    };
    expect(foldersInUse(panes, { host: undefined }, [lead, peer])).toEqual(["/home/you/lead", "/home/you/untagged"]);
    expect(foldersInUse(panes, { host: "workshop" }, [lead, peer])).toEqual(["/home/w/peer"]);
  });

  it("has nothing for a machine whose panes report no folder (zellij)", () => {
    const panes = { agents: [pane({ paneId: "w1:p1", cwd: "" })], shellPanes: [pane({ paneId: "w1:p2", cwd: "" })] };
    expect(foldersInUse(panes, undefined, [])).toEqual([]);
  });
});

describe("openNowRows — what the section draws", () => {
  const list = { recent: ["/srv/r/"], favourites: ["/srv/f"], home: "/home/you/" };

  it("leaves out home and every folder under Favourites or Recent, whatever the trailing slash", () => {
    expect(openNowRows(["/home/you", "/srv/f/", "/srv/r", "/srv/open"], list)).toEqual(["/srv/open"]);
  });

  it("is capped at eight, after the lists took theirs", () => {
    const inUse = ["/srv/f", ...Array.from({ length: MAX_OPEN_NOW + 2 }, (_, i) => `/srv/p${i}`)];
    const rows = openNowRows(inUse, list);
    expect(rows).toHaveLength(MAX_OPEN_NOW);
    expect(rows[0]).toBe("/srv/p0");
  });
});
