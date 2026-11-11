import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrickViewSession, TrickViewSwitchBody } from "@/lib/agent-view/wire";
import type { WireTrickInfo } from "@/lib/tricks/schema";

// Which views a session's sheet offers, and where a send from the view goes. The tricks list and the
// bridge's views are the two stores the hook joins; both are stubbed here.

interface Stores {
  tricks: WireTrickInfo[];
  views: TrickViewSession[];
  available: boolean;
}
interface Switched {
  posts: TrickViewSwitchBody[];
  noted: TrickViewSession[];
  refetched: number;
}
const state = vi.hoisted((): Stores => ({ tricks: [], views: [], available: true }));
const switched = vi.hoisted((): Switched => ({ posts: [], noted: [], refetched: 0 }));

vi.mock("@/lib/tricks/store", () => ({ useTricksState: () => ({ tricks: state.tricks }) }));
vi.mock("@/lib/agent-view/store", () => ({
  useShowAgentViews: () => undefined,
  useAgentViewsAvailable: () => state.available,
  useAgentViewsOf: () => state.views,
  viewKey: (id: string, session: string) => `${id}\u0000${session}`,
  noteAgentViewSwitch: (answered: TrickViewSession) => switched.noted.push(answered),
  refetchAgentViews: () => {
    switched.refetched += 1;
    return Promise.resolve();
  },
}));
vi.mock("@/lib/api", () => ({
  postTrickViewSwitch: (body: TrickViewSwitchBody) => {
    switched.posts.push(body);
    return Promise.resolve(null);
  },
}));

const { useAgentViewPane } = await import("./use-agent-view-pane");

const ADDRESS = "local/w1:p1#ab12";

function trick(id: string, name: string, over: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "lodge", id, name, icon: "eye", on: true, state: "ok", places: [], agentView: true, ...over };
}

function view(trickId: string, over: Partial<TrickViewSession> = {}): TrickViewSession {
  return { trick: trickId, session: ADDRESS, on: true, ...over };
}

function pane(eligible = true) {
  return renderHook(() => useAgentViewPane({ address: ADDRESS, eligible, onChanged: vi.fn() }));
}

beforeEach(() => {
  state.tricks = [];
  state.views = [];
  state.available = true;
  switched.posts = [];
  switched.noted = [];
  switched.refetched = 0;
});

describe("lead 2: which views a session offers", () => {
  it("one row per trick that is on and lists agent-view, named by the trick cut to 12 characters", () => {
    state.tricks = [trick("morph", "Morph"), trick("board", "Release board view"), trick("off", "Off one", { on: false }), trick("plain", "Plain", { agentView: undefined })];
    const { result } = pane();
    expect(result.current.available).toBe(true);
    expect(result.current.rows).toEqual([
      { trick: "morph", label: "Morph", on: false },
      { trick: "board", label: "Release boa…", on: false },
    ]);
    expect(result.current.on).toBe(false);
  });

  it("offers nothing on a pane that may not have a view, or a bridge without them, or with no trick", () => {
    state.tricks = [trick("morph", "Morph")];
    expect(pane(false).result.current.available).toBe(false);
    state.available = false;
    expect(pane().result.current.available).toBe(false);
    state.available = true;
    state.tricks = [];
    expect(pane().result.current.available).toBe(false);
  });

  it("the view that is on names the View choice and the band, and is the send target", () => {
    state.tricks = [trick("morph", "Morph"), trick("board", "Release board view")];
    state.views = [view("board")];
    const { result } = pane();
    expect(result.current.rows.map((row) => row.on)).toEqual([false, true]);
    expect(result.current.label).toBe("Release boa…");
    expect(result.current.name).toBe("Release board view");
    expect(result.current.target).toEqual({ trick: "board", session: ADDRESS });
  });

  it("a switch posts the trick and the session and notes the bridge's answer", async () => {
    state.tricks = [trick("morph", "Morph")];
    const { result } = pane();
    await act(async () => {
      expect(await result.current.setOn("morph", true)).toBeNull();
    });
    expect(switched.posts).toEqual([{ trick: "morph", session: ADDRESS, on: true }]);
  });
});

describe("lead 2: a question in the session", () => {
  it("leaves no view target, so typed text goes as a plain composer send", () => {
    state.tricks = [trick("morph", "Morph")];
    state.views = [view("morph", { question: true })];
    const { result } = pane();
    expect(result.current.question).toBe(true);
    expect(result.current.showing).toBe(true);
    expect(result.current.target).toBeUndefined();
  });

  it("leaves no view target while Chat stands in for the view", () => {
    state.tricks = [trick("morph", "Morph")];
    state.views = [view("morph")];
    const { result } = pane();
    act(() => result.current.setAside("chat"));
    expect(result.current.showing).toBe(false);
    expect(result.current.target).toBeUndefined();
  });
});

describe("lead 5: a stale tap", () => {
  it("reads the views again once and says the screen changed until the next send", () => {
    state.tricks = [trick("morph", "Morph")];
    state.views = [view("morph")];
    const { result } = pane();
    act(() => result.current.noteChanged());
    expect(switched.refetched).toBe(1);
    expect(result.current.changed).toBe(true);
    act(() => result.current.noteRequest({ text: "again", phase: "sending", reason: null, line: null }));
    expect(result.current.changed).toBe(false);
  });
});
