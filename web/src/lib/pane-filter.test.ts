import { describe, expect, it } from "vitest";

import { queryTerms } from "@/lib/fuzzy";
import { paneRowKey } from "@/lib/hosts";
import {
  byScore,
  filterOffered,
  matchPane,
  matchPanes,
  PANE_FILTER,
  paneFields,
  type MatchPaneOptions,
  type PaneField,
} from "@/lib/pane-filter";
import type { AgentView, ServerSummary, TabView } from "@/lib/types";

function pane(over: Partial<AgentView> & { paneId: string }): AgentView {
  return {
    workspaceId: "w1",
    workspaceLabel: "collie-workspace",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/projects/collie-workspace",
    focused: false,
    ...over,
  };
}

// One row per multiplexer, as each one's bridge spells it, and a crew member's.
const HERDR = pane({
  paneId: "w1:p1",
  paneLabel: "release notes",
  tabLabel: "docs",
  gitHead: { kind: "branch", name: "fix/748-sheet" },
});
// tmux names a window itself; the bridge sends it as the sole tab's name only when it was chosen.
const TMUX = pane({
  paneId: "%3",
  workspaceId: "$1",
  workspaceLabel: "moonward",
  tabId: "@2",
  tabLabel: "build",
  soleTabName: "build",
  agent: "codex",
  cwd: "/srv/moonward/api",
  gitHead: { kind: "detached", sha: "0123456789abcdef" },
});
// zellij's own default tab name is positional and never reaches the screen as a name.
const ZELLIJ = pane({
  paneId: "terminal_4",
  workspaceId: "main",
  workspaceLabel: "sandbox",
  tabId: "main:0",
  tabLabel: "Tab #2",
  agent: "pi",
  terminalTitle: "Prüfung der Änderungen",
  cwd: "/home/you/sandbox",
});
const SHELL = pane({ paneId: "w1:p9", workspaceLabel: "scratch", agent: "shell", kind: "shell", status: "unknown", cwd: "/home/you/scratch" });
const MEMBER = pane({ paneId: "w1:p1", host: "workshop", paneLabel: "triage", workspaceLabel: "peerproj", agent: "opencode", cwd: "/home/k/peerproj" });

const SERVERS: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "workshop", name: "workshop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

/** The switcher's row: the name, the space and the tab are text; the rest is not. */
const SWITCHER: ReadonlySet<PaneField> = new Set<PaneField>(["name", "space", "tab"]);
const OPTS: MatchPaneOptions = { level: PANE_FILTER.level, drawn: SWITCHER, hidden: PANE_FILTER.hidden };

const hitOf = (p: AgentView, query: string, opts: Partial<MatchPaneOptions> = {}) =>
  matchPane(paneFields(p, { servers: SERVERS }), queryTerms(query), { ...OPTS, ...opts });

describe("paneFields", () => {
  it("reads a Herdr row through the helpers the rows draw with", () => {
    expect(paneFields(HERDR)).toEqual({
      name: "release notes",
      space: "collie-workspace",
      tab: "docs",
      branch: "fix/748-sheet",
      folder: "collie-workspace",
      agent: "claude",
      machine: "",
    });
  });

  it("names a tmux window as its tab and a detached head as BranchLabel spells it", () => {
    const fields = paneFields(TMUX);
    expect(fields.name).toBe("build");
    expect(fields.tab).toBe("build");
    expect(fields.branch).toBe("detached @0123456");
    expect(fields.folder).toBe("api");
    expect(fields.agent).toBe("codex");
  });

  it("reads zellij's positional tab as the row shows it, and the title as the name", () => {
    const fields = paneFields(ZELLIJ);
    expect(fields.tab).toBe("tab 2");
    expect(fields.name).toBe("Prüfung der Änderungen");
    expect(fields.branch).toBe("");
  });

  it("gives a bare shell no agent name", () => {
    expect(paneFields(SHELL).agent).toBe("");
    expect(paneFields(SHELL).name).toBe("shell");
  });

  it("names a crew member's machine only on a crew, as HostChip does", () => {
    expect(paneFields(MEMBER, { servers: SERVERS }).machine).toBe("workshop");
    expect(paneFields(MEMBER).machine).toBe("");
    expect(paneFields(MEMBER, { servers: [SERVERS[0]!] }).machine).toBe("");
    expect(paneFields(HERDR, { servers: SERVERS }).machine).toBe("");
  });

  it("takes the tab's label from the raw tab list when given, host by host", () => {
    const tabs: TabView[] = [{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: "review", focused: false, paneCount: 1 }];
    expect(paneFields(HERDR, { tabs }).tab).toBe("review");
  });
});

describe("matchPane", () => {
  it("finds a row by an abbreviation of its space, and marks the letters", () => {
    const hit = hitOf(HERDR, "cw");
    expect(hit).not.toBeNull();
    expect(hit!.marks.space).toEqual([
      [0, 1],
      [7, 8],
    ]);
    expect(hit!.via).toBeNull();
  });

  it("needs every term to match some field (AND)", () => {
    expect(hitOf(HERDR, "release docs")).not.toBeNull();
    expect(hitOf(HERDR, "release moonward")).toBeNull();
  });

  it("lets different terms match different fields, and merges a field's marks over the terms", () => {
    const hit = hitOf(HERDR, "rel notes")!;
    expect(hit.marks.name).toEqual([
      [0, 3],
      [8, 13],
    ]);
  });

  it("folds case and diacritics", () => {
    expect(hitOf(ZELLIJ, "PRUFUNG")).not.toBeNull();
    expect(hitOf(ZELLIJ, "anderungen")).not.toBeNull();
  });

  it("names the undrawn field when a term matched only there", () => {
    const hit = hitOf(HERDR, "f7")!;
    expect(hit.via).toBe("branch");
    expect(hit.marks.branch).toEqual([
      [0, 1],
      [4, 5],
    ]);
  });

  it("has no via when the same term also matched a drawn field", () => {
    // "collie" is the space (drawn) and the folder (not drawn).
    const hit = hitOf(HERDR, "collie")!;
    expect(hit.via).toBeNull();
    expect(hit.marks.space).toEqual([[0, 6]]);
    expect(hit.marks.folder).toEqual([[0, 6]]);
  });

  it("finds a row by its agent's name and by its machine, both undrawn in the switcher", () => {
    expect(hitOf(MEMBER, "opencode")!.via).toBe("agent");
    expect(hitOf(MEMBER, "workshop")!.via).toBe("machine");
  });

  it("with drawn-only searches no undrawn field but the agent", () => {
    const drawnOnly = { hidden: "drawn-only" as const };
    expect(hitOf(HERDR, "f7", drawnOnly)).toBeNull();
    expect(hitOf(MEMBER, "workshop", drawnOnly)).toBeNull();
    expect(hitOf(MEMBER, "opencode", drawnOnly)!.via).toBe("agent");
  });

  it("computes via against the surface's own drawn set", () => {
    // A row that draws the branch (as the dashboard's does) needs no via line for it.
    const drawsBranch = new Set<PaneField>(["name", "space", "tab", "branch"]);
    expect(hitOf(HERDR, "f7", { drawn: drawsBranch })!.via).toBeNull();
  });

  it("matches less at the anchored level than at the loose one", () => {
    expect(hitOf(HERDR, "lsnt")).toBeNull();
    expect(hitOf(HERDR, "lsnt", { level: "loose" })).not.toBeNull();
  });

  it("scores the sum of each term's best field", () => {
    const one = hitOf(HERDR, "release")!.score;
    const two = hitOf(HERDR, "release docs")!.score;
    expect(two).toBeGreaterThan(one);
  });
});

describe("matchPanes", () => {
  const rows = [HERDR, TMUX, ZELLIJ, SHELL, MEMBER];

  it("is null for a query with no term, so the caller renders as before", () => {
    expect(matchPanes(rows, "", OPTS)).toBeNull();
    expect(matchPanes(rows, "   ", OPTS)).toBeNull();
  });

  it("keys each matched row by its full address", () => {
    const hits = matchPanes(rows, "collie", { ...OPTS, ctx: { servers: SERVERS } })!;
    expect([...hits.keys()]).toEqual([paneRowKey(HERDR)]);
    expect(hits.get(paneRowKey(HERDR))!.fields.name).toBe("release notes");
  });

  it("tells two machines' `w1:p1` apart", () => {
    const hits = matchPanes(rows, "workshop", { ...OPTS, ctx: { servers: SERVERS } })!;
    expect(hits.has(paneRowKey(MEMBER))).toBe(true);
    expect(hits.has(paneRowKey(HERDR))).toBe(false);
  });
});

describe("byScore", () => {
  it("puts the best match first and keeps the place order on a tie", () => {
    const a = pane({ paneId: "a", paneLabel: "build api" });
    const b = pane({ paneId: "b", paneLabel: "api" });
    const c = pane({ paneId: "c", paneLabel: "api" });
    const d = pane({ paneId: "d", paneLabel: "other" });
    const hits = matchPanes([a, b, c, d], "api", OPTS)!;
    expect(byScore([a, b, c, d], hits).map((p) => p.paneId)).toEqual(["b", "c", "a"]);
  });
});

describe("filterOffered", () => {
  it("offers the field only above five session rows", () => {
    expect(filterOffered(5)).toBe(false);
    expect(filterOffered(6)).toBe(true);
  });
});
