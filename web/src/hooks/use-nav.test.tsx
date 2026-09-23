import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

import type { NavState } from "@/lib/nav";
import type { AgentView } from "@/lib/types";

import { useNav, type Nav } from "./use-nav";

// The hook against a real (memory) router: what each move does to the history stack. The level
// tree and the parent choice are pinned in lib/nav.test.ts; this pins push, replace and step back.

const FRESH: AgentView = {
  paneId: "p1",
  workspaceId: "w1",
  workspaceLabel: "w1",
  workspaceNumber: 0,
  tabId: "w1:t1",
  agent: "shell",
  status: "unknown",
  cwd: "/tmp",
  focused: false,
  kind: "shell",
};

let nav: Nav;
function Probe() {
  nav = useNav();
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

function mount(initial = "/") {
  const routes = ["/", "/space/:id", "/space/:id/changes", "/pane/:id", "/pane/:id/history", "/settings", "/settings/updates"].map(
    (path) => ({ path, element: <Probe /> }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [initial] });
  render(<RouterProvider router={router} />);
  const at = () => `${router.state.location.pathname}${router.state.location.search}`;
  // SAFETY: every navigation in these cases goes through `useNav`, which writes `NavState` or nothing.
  const state = () => router.state.location.state as NavState | null;
  return { router, at, state };
}

describe("useNav", () => {
  it("down pushes and records where it came from", async () => {
    const { router, at, state } = mount("/?h=a");
    await act(async () => nav.down("/pane/p1?h=a", { freshPane: FRESH }));
    expect(at()).toBe("/pane/p1?h=a");
    expect(state()).toEqual({ freshPane: FRESH, from: "/?h=a" });
    await act(() => router.navigate(-1));
    expect(at()).toBe("/?h=a");
  });

  it("side replaces and carries the way up across the switch", async () => {
    const { router, at, state } = mount();
    await act(async () => nav.down("/pane/a"));
    await act(async () => nav.side("/pane/b"));
    expect(state()).toEqual({ from: "/" });
    // A (swipe) back from pane B lands on the dashboard, not on pane A.
    await act(() => router.navigate(-1));
    expect(at()).toBe("/");
  });

  it("up steps back onto the parent the level was opened from", async () => {
    const { router, at } = mount();
    await act(async () => nav.down("/space/w1"));
    await act(async () => nav.down("/pane/p1"));
    await act(async () => nav.up("/"));
    expect(at()).toBe("/space/w1");
    await act(async () => nav.up("/"));
    expect(at()).toBe("/");
    // Nothing is left above: forward is where the levels went, not back.
    expect(router.state.historyAction).toBe("POP");
  });

  it("up replaces onto the structural parent when the entry behind is not one", async () => {
    const { router, at } = mount("/pane/p1");
    await act(async () => nav.down("/settings"));
    await act(async () => nav.up("/"));
    expect(at()).toBe("/");
    // Settings is gone from the stack: the next back is the pane, not Settings again.
    await act(() => router.navigate(-1));
    expect(at()).toBe("/pane/p1");
  });

  it("open is a step down from a space and sideways from a pane", async () => {
    const { at, state } = mount("/space/w1");
    await act(async () => nav.open("/pane/p1"));
    expect(state()).toEqual({ from: "/space/w1" });
    await act(async () => nav.open("/pane/p2"));
    expect(at()).toBe("/pane/p2");
    expect(state()).toEqual({ from: "/space/w1" });
  });

  it("upTo steps back only onto that named parent, else replaces and keeps the level above it", async () => {
    const { router, at, state } = mount();
    await act(async () => nav.down("/pane/p1"));
    await act(async () => nav.upTo("/space/w1"));
    expect(at()).toBe("/space/w1");
    // The dashboard the pane came from is still behind, and the space knows it.
    expect(state()).toEqual({ from: "/" });
    await act(async () => nav.up("/"));
    expect(at()).toBe("/");
    expect(router.state.historyAction).toBe("POP");
  });
});
