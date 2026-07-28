import { describe, expect, it } from "vitest";

import {
  flipDir,
  isUnseen,
  triage,
  TRIAGE_STATUS,
  worstTriage,
  type TriageKey,
} from "./triage";
import type { AgentStatus, AgentView } from "./types";

function agent(
  paneId: string,
  status: AgentStatus,
  ts: { active?: number; seen?: number } = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w0",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
    ...(ts.active !== undefined ? { lastActiveAt: ts.active } : {}),
    ...(ts.seen !== undefined ? { lastSeenAt: ts.seen } : {}),
  };
}

/** The section an agent landed in, by pane id. */
function sectionOf(sections: ReturnType<typeof triage>, paneId: string): TriageKey | undefined {
  return sections.find((s) => s.agents.some((a) => a.paneId === paneId))?.key;
}

const ids = (sections: ReturnType<typeof triage>, key: TriageKey) =>
  sections.find((s) => s.key === key)!.agents.map((a) => a.paneId);

describe("isUnseen", () => {
  it("is true for a done agent that finished after you last looked", () => {
    expect(isUnseen(agent("p", "done", { active: 200, seen: 100 }))).toBe(true);
  });

  it("is false once you've looked since it finished", () => {
    expect(isUnseen(agent("p", "done", { active: 100, seen: 200 }))).toBe(false);
  });

  it("is false at the exact tie — a look at the same ms counts as seen", () => {
    expect(isUnseen(agent("p", "done", { active: 100, seen: 100 }))).toBe(false);
  });

  it("only ever applies to done agents", () => {
    for (const s of ["working", "idle", "blocked", "unknown"] as AgentStatus[]) {
      expect(isUnseen(agent("p", s, { active: 200, seen: 100 }))).toBe(false);
    }
  });

  it("is false when the bridge reports no timestamps", () => {
    expect(isUnseen(agent("p", "done"))).toBe(false);
  });
});

describe("triage — bucketing", () => {
  it("puts each agent in exactly one section, in the documented priority", () => {
    const s = triage([
      agent("blocked", "blocked", { active: 500, seen: 100 }),
      agent("unseen", "done", { active: 400, seen: 100 }),
      agent("working", "working", { active: 300, seen: 100 }),
      agent("seen-done", "done", { active: 100, seen: 400 }),
      agent("idle", "idle", { active: 100, seen: 200 }),
      agent("unknown", "unknown", { active: 100, seen: 200 }),
    ]);

    expect(sectionOf(s, "blocked")).toBe("needs");
    expect(sectionOf(s, "unseen")).toBe("ready");
    expect(sectionOf(s, "working")).toBe("working");
    expect(sectionOf(s, "seen-done")).toBe("recent");
    expect(sectionOf(s, "idle")).toBe("recent");
    expect(sectionOf(s, "unknown")).toBe("recent");
  });

  it("blocked outranks unseen — an agent that blocked after finishing still needs you", () => {
    const s = triage([agent("p", "blocked", { active: 900, seen: 1 })]);
    expect(sectionOf(s, "p")).toBe("needs");
  });

  it("returns all four sections in fixed order, empty ones included", () => {
    const s = triage([]);
    expect(s.map((x) => x.key)).toEqual(["needs", "ready", "working", "recent"]);
    expect(s.every((x) => x.agents.length === 0)).toBe(true);
  });

  it("marks only Recent collapsible — an alert you can fold away is not an alert", () => {
    const s = triage([]);
    expect(s.filter((x) => x.collapsible).map((x) => x.key)).toEqual(["recent"]);
  });
});

describe("triage — ordering", () => {
  it("orders attention sections by most recent activity", () => {
    const s = triage([
      agent("old", "blocked", { active: 100, seen: 0 }),
      agent("new", "blocked", { active: 900, seen: 0 }),
      agent("mid", "blocked", { active: 500, seen: 0 }),
    ]);
    expect(ids(s, "needs")).toEqual(["new", "mid", "old"]);
  });

  it("orders Ready by most recently finished", () => {
    const s = triage([
      agent("a", "done", { active: 100, seen: 1 }),
      agent("b", "done", { active: 900, seen: 1 }),
    ]);
    expect(ids(s, "ready")).toEqual(["b", "a"]);
  });

  it("orders Recent by when you last used it, newest first by default", () => {
    const s = triage([
      agent("stale", "idle", { active: 1, seen: 100 }),
      agent("fresh", "idle", { active: 1, seen: 900 }),
      agent("mid", "idle", { active: 1, seen: 500 }),
    ]);
    expect(ids(s, "recent")).toEqual(["fresh", "mid", "stale"]);
  });

  it("the direction toggle inverts Recent", () => {
    const herd = [
      agent("stale", "idle", { active: 1, seen: 100 }),
      agent("fresh", "idle", { active: 1, seen: 900 }),
      agent("mid", "idle", { active: 1, seen: 500 }),
    ];
    expect(ids(triage(herd, "oldest"), "recent")).toEqual(["stale", "mid", "fresh"]);
  });

  it("the direction toggle does NOT reach the pinned sections", () => {
    const herd = [
      agent("old", "blocked", { active: 100, seen: 0 }),
      agent("new", "blocked", { active: 900, seen: 0 }),
      agent("w-old", "working", { active: 100, seen: 0 }),
      agent("w-new", "working", { active: 900, seen: 0 }),
      agent("r-old", "done", { active: 900, seen: 1 }),
      agent("r-new", "done", { active: 950, seen: 1 }),
    ];
    for (const dir of ["newest", "oldest"] as const) {
      const s = triage(herd, dir);
      expect(ids(s, "needs")).toEqual(["new", "old"]);
      expect(ids(s, "working")).toEqual(["w-new", "w-old"]);
      expect(ids(s, "ready")).toEqual(["r-new", "r-old"]);
    }
  });
});

describe("triage — an older bridge that reports no timestamps", () => {
  const herd = [
    agent("b1", "blocked"),
    agent("b2", "blocked"),
    agent("w1", "working"),
    agent("i1", "idle"),
    agent("d1", "done"),
  ];

  it("leaves Ready·unseen empty rather than guessing", () => {
    expect(ids(triage(herd), "ready")).toEqual([]);
  });

  it("preserves the order the bridge sent, because the sort is stable", () => {
    const s = triage(herd);
    expect(ids(s, "needs")).toEqual(["b1", "b2"]);
    expect(ids(s, "working")).toEqual(["w1"]);
    expect(ids(s, "recent")).toEqual(["i1", "d1"]);
  });

  it("still buckets by status, so the dashboard is coherent", () => {
    const s = triage(herd);
    expect(sectionOf(s, "b1")).toBe("needs");
    expect(sectionOf(s, "w1")).toBe("working");
    expect(sectionOf(s, "d1")).toBe("recent");
  });

  it("does not mutate the input array", () => {
    const input = [agent("z", "idle", { seen: 1 }), agent("a", "idle", { seen: 9 })];
    const before = input.map((a) => a.paneId);
    triage(input);
    expect(input.map((a) => a.paneId)).toEqual(before);
  });
});

describe("flipDir", () => {
  it("round-trips", () => {
    expect(flipDir("newest")).toBe("oldest");
    expect(flipDir("oldest")).toBe("newest");
  });
});

describe("worstTriage — what a tab or space chip advertises", () => {
  it("reports the most urgent thing inside, not the first", () => {
    expect(worstTriage([agent("a", "idle", { seen: 5 }), agent("b", "blocked")])).toBe("needs");
    expect(worstTriage([agent("a", "idle", { seen: 5 }), agent("b", "working")])).toBe("working");
  });

  it("ranks blocked over ready over working over the rest", () => {
    const blocked = agent("x", "blocked");
    const ready = agent("y", "done", { active: 9, seen: 1 });
    const working = agent("z", "working");
    const idle = agent("i", "idle", { seen: 5 });
    expect(worstTriage([idle, working, ready, blocked])).toBe("needs");
    expect(worstTriage([idle, working, ready])).toBe("ready");
    expect(worstTriage([idle, working])).toBe("working");
    expect(worstTriage([idle])).toBe("recent");
  });

  it("is null for a container with no agents — that is NOT the same as idle", () => {
    // An empty tab has nothing to report; a resting dot would claim otherwise.
    expect(worstTriage([])).toBeNull();
  });

  it("agrees with triage() about which bucket an agent is in", () => {
    const herd = [
      agent("b", "blocked"),
      agent("r", "done", { active: 9, seen: 1 }),
      agent("w", "working"),
      agent("i", "idle", { seen: 5 }),
    ];
    for (const a of herd) {
      const section = triage([a]).find((s) => s.agents.length > 0)!;
      expect(worstTriage([a])).toBe(section.key);
    }
  });
});

describe("TRIAGE_STATUS", () => {
  it("maps every bucket to the status whose colour it should borrow", () => {
    expect(TRIAGE_STATUS).toEqual({
      needs: "blocked",
      ready: "done",
      working: "working",
      recent: "idle",
    });
  });
});
