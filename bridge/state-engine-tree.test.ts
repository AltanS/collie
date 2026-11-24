import { describe, expect, test } from "bun:test";

import type { MuxAdapter, MuxPane } from "./mux/types.ts";
import { StateEngine } from "./state-engine.ts";

describe("StateEngine: a pane's place in a tree of agents", () => {
  function pane(fields: Partial<MuxPane>): MuxPane {
    return {
      paneId: "w1:p1",
      spaceId: "w1",
      spaceLabel: "work",
      spaceNumber: 1,
      tabId: "w1:t1",
      cwd: "/srv/work",
      focused: false,
      alive: true,
      agent: "claude",
      status: "idle",
      ...fields,
    };
  }

  async function viewsOf(panes: readonly MuxPane[]) {
    const stub: Partial<MuxAdapter> = {
      reachable: () => Promise.resolve(true),
      snapshot: () => Promise.resolve({ panes, spaces: [], tabs: [] }),
    };
    // SAFETY: a poll of panes that name no Claude session reaches `snapshot()` and `reachable()` and
    // nothing else, and the stub has both.
    const engine = new StateEngine(stub as MuxAdapter, 1500);
    await engine["poll"]();
    const now = engine.current();
    return [...now.agents, ...now.shellPanes];
  }

  test("the tree rides onto the view", async () => {
    const [view] = await viewsOf([pane({ tree: { id: "a1", parent: "b2", role: "worker" } })]);
    expect(view?.tree).toEqual({ id: "a1", parent: "b2", role: "worker" });
  });

  test("a pane in no tree gains no key", async () => {
    const [view] = await viewsOf([pane({})]);
    expect(view).toBeDefined();
    expect("tree" in view!).toBe(false);
  });
});
