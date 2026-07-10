import { renderHook } from "@testing-library/react";

import { SUPERSEDE_MS, intervalFor, usePolling } from "./use-polling";
import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";

// usePolling reads useRevalidator(); drive its state/revalidate directly (hoisted so the vi.mock
// factory can close over the holder). intervalFor is pure and doesn't touch it.
const rr = vi.hoisted(() => ({ state: "idle" as "idle" | "loading", revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: rr.state, revalidate: rr.revalidate }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(paneId: string, status: AgentView["status"]): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/",
    focused: false,
  };
}

function makeShell(paneId: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/",
    focused: false,
    kind: "shell",
  };
}

function makeData(agents: AgentView[], shellPanes: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes,
    workspaces: [],
    tabs: [],
    sessions: [],
    session: undefined,
    snoozedUntil: null,
    error: false,
  };
}

const HOT = 1500;
const COLD = 4000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intervalFor", () => {
  it("returns COLD when data is undefined and no pane is open", () => {
    expect(intervalFor(undefined)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no pane is open", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no paneId is provided (home screen)", () => {
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, null)).toBe(COLD);
  });

  it("returns HOT when any agent in the herd is working", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "working")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when any agent in the herd is blocked", () => {
    const data = makeData([makeAgent("w1:p1", "blocked"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when herd is idle but the open pane is an agent pane that is working", () => {
    // The open agent is idle globally but let's test: open pane exists in agents → HOT.
    // More precisely: the rule is "pane exists in agents ∪ shellPanes" → HOT regardless of status.
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, "w1:p1")).toBe(HOT);
  });

  it("returns HOT when the open pane is a shell (shells are always live when open)", () => {
    const data = makeData([], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w1:s1")).toBe(HOT);
  });

  it("returns COLD when a paneId is given but it matches no pane in agents or shellPanes", () => {
    const data = makeData([makeAgent("w1:p1", "idle")], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w99:phantom")).toBe(COLD);
  });

  it("returns HOT (from herd) even when paneId is absent", () => {
    const data = makeData([makeAgent("w1:p1", "working")]);
    expect(intervalFor(data, undefined)).toBe(HOT);
  });
});

// The self-heal: a revalidation wedged in "loading" (a black-holed fetch) would otherwise no-op
// every future tick, since the fast-path only revalidates while idle. Once it has been loading past
// SUPERSEDE_MS, a tick kicks a fresh revalidate() to supersede the hung one.
describe("usePolling — superseding a wedged revalidation", () => {
  const hotData = () => makeData([makeAgent("w1:p1", "working")]); // HOT → 1500ms tick interval

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT revalidate on a tick before SUPERSEDE_MS has elapsed", () => {
    rr.state = "loading"; // stuck loading from the very first render
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(SUPERSEDE_MS - 1); // several HOT ticks, all still within the grace window
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("DOES revalidate once a load has been stuck past SUPERSEDE_MS", () => {
    rr.state = "loading";
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(SUPERSEDE_MS); // a tick now sees the load has aged past the threshold
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("still uses the plain idle fast-path when not loading", () => {
    rr.state = "idle";
    renderHook(() => usePolling(hotData()));
    vi.advanceTimersByTime(1_500); // one HOT tick
    expect(rr.revalidate).toHaveBeenCalled();
  });
});
