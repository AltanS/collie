import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

import type { NavState } from "@/lib/nav";
import { navTrail } from "@/lib/nav-trail";
import type { AgentView } from "@/lib/types";

import { POP_REPLACE_WAIT_MS, useNav, type Nav } from "./use-nav";

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

function mount(initial: string | string[] = "/") {
  const routes = ["/", "/space/:id", "/space/:id/changes", "/pane/:id/changes", "/pane/:id/changes/files", "/pane/:id", "/pane/:id/history", "/settings", "/settings/updates", "/new"].map(
    (path) => ({ path, element: <Probe /> }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [initial].flat() });
  const { unmount } = render(<RouterProvider router={router} />);
  const at = () => `${router.state.location.pathname}${router.state.location.search}`;
  // SAFETY: every navigation in these cases goes through `useNav`, which writes `NavState` or nothing.
  const state = () => router.state.location.state as NavState | null;
  return { router, at, state, unmount };
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

  it("open from the New page replaces it, so Back does not land on a form that was used", async () => {
    const { router, at, state } = mount("/");
    await act(async () => nav.down("/new"));
    expect(state()).toEqual({ from: "/" });
    await act(async () => nav.open("/pane/p1"));
    expect(at()).toBe("/pane/p1");
    expect(state()).toEqual({ from: "/" });
    expect(router.state.historyAction).toBe("REPLACE");
    await act(() => router.navigate(-1));
    expect(at()).toBe("/");
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

describe("useNav: the Files tree's moves", () => {
  const FILES = "/pane/p1/changes/files";
  const ROOT = "/pane/p1/changes";

  afterEach(() => {
    // SAFETY: restores jsdom's own accessor, which `stampIdx` shadowed on the instance.
    Reflect.deleteProperty(window.history, "state");
  });

  /** A memory router stamps no `history.state.idx`; the browser router does. Stand in for it. */
  function stampIdx(idx: number) {
    Object.defineProperty(window.history, "state", { configurable: true, get: () => ({ idx }) });
  }

  /** A router whose entries are `hrefs`, standing on the last, with the trail the effect would have written. */
  function walked(...hrefs: string[]) {
    hrefs.forEach((href, idx) => navTrail.record(idx, href));
    stampIdx(hrefs.length - 1);
    return mount(hrefs);
  }

  it("upTree steps back to whatever the entry came from, here a pane, not up the folders", async () => {
    const { router, at } = mount("/pane/p1");
    await act(async () => nav.down(`${FILES}?path=src%2Flib%2Fnav.ts`));
    await act(async () => nav.upTree(`${FILES}?dir=src%2Flib`));
    expect(at()).toBe("/pane/p1");
    expect(router.state.historyAction).toBe("POP");
  });

  it("upTree replaces onto the parent folder on a cold entry", async () => {
    const { router, at } = mount(`${FILES}?dir=src%2Flib`);
    await act(async () => nav.upTree(`${FILES}?dir=src`));
    expect(at()).toBe(`${FILES}?dir=src`);
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("a crumb pops back to the ancestor folder in the stack instead of stacking it again", async () => {
    const { router, at } = walked("/pane/p1", ROOT, `${FILES}?dir=a`, `${FILES}?dir=a%2Fb`, `${FILES}?dir=a%2Fb%2Fc`);
    await act(async () => nav.crumb(`${FILES}?dir=a`));
    expect(at()).toBe(`${FILES}?dir=a`);
    expect(router.state.historyAction).toBe("POP");
    // The stack is root, a with a/b and a/b/c forward of it: a swipe goes up, not down.
    await act(() => router.navigate(-1));
    expect(at()).toBe(ROOT);
  });

  it("the root crumb pops to the root", async () => {
    const { at } = walked("/pane/p1", ROOT, `${FILES}?dir=a`, `${FILES}?dir=a%2Fb`);
    await act(async () => nav.crumb(ROOT));
    expect(at()).toBe(ROOT);
  });

  it("a crumb whose folder is not behind us replaces and carries no from", async () => {
    const { router, at, state } = walked("/pane/p1", `${FILES}?dir=a%2Fb`);
    await act(async () => nav.crumb(ROOT));
    expect(at()).toBe(ROOT);
    expect(router.state.historyAction).toBe("REPLACE");
    expect(state()).toBeNull();
    // The pane is still the entry behind, and the way up from here is the structural one.
    await act(() => router.navigate(-1));
    expect(at()).toBe("/pane/p1");
  });

  it("a crumb above where the tree was entered pops there and makes that entry the folder", async () => {
    const { router, at } = walked("/pane/p1", `${FILES}?dir=a%2Fb`, `${FILES}?dir=a%2Fb%2Fc`);
    await act(async () => nav.crumb(`${FILES}?dir=a`));
    // A memory router fires no popstate and stamps no index; the browser does both, once the pop lands.
    stampIdx(1);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(at()).toBe(`${FILES}?dir=a`);
    expect(router.state.historyAction).toBe("REPLACE");
    // Nothing below `a` is behind it: a swipe goes to the pane.
    await act(() => router.navigate(-1));
    expect(at()).toBe("/pane/p1");
  });

  it("a pop that never lands leaves no listener behind for the next, unrelated back", async () => {
    vi.useFakeTimers();
    try {
      const { at } = walked("/pane/p1", `${FILES}?dir=a%2Fb`, `${FILES}?dir=a%2Fb%2Fc`);
      await act(async () => nav.crumb(`${FILES}?dir=a`));
      // The browser had dropped the entry: no popstate comes. A second later the move is over.
      await act(async () => {
        vi.advanceTimersByTime(POP_REPLACE_WAIT_MS + 1);
      });
      // The operator's next back is somewhere else entirely and must not be rewritten.
      stampIdx(0);
      await act(async () => {
        window.dispatchEvent(new PopStateEvent("popstate"));
        vi.advanceTimersByTime(50);
      });
      expect(at()).not.toBe(`${FILES}?dir=a`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pop that lands on another entry than the move meant replaces nothing", async () => {
    const { router, at } = walked("/pane/p1", `${FILES}?dir=a%2Fb`, `${FILES}?dir=a%2Fb%2Fc`);
    await act(async () => nav.crumb(`${FILES}?dir=a`));
    // The popstate arrives, but the entry stamped on history is not idx - steps.
    stampIdx(0);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(router.state.historyAction).not.toBe("REPLACE");
    expect(at()).not.toBe(`${FILES}?dir=a`);
  });

  it("a move still waiting for its pop is dropped when the hook unmounts", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = walked("/pane/p1", `${FILES}?dir=a%2Fb`, `${FILES}?dir=a%2Fb%2Fc`);
    await act(async () => nav.crumb(`${FILES}?dir=a`));
    unmount();
    expect(remove.mock.calls.some(([type]) => type === "popstate")).toBe(true);
    remove.mockRestore();
  });

  it("a crumb on the place you are does nothing", async () => {
    const { router, at } = walked("/pane/p1", `${FILES}?dir=a`);
    await act(async () => nav.crumb(`${FILES}?dir=a`));
    expect(at()).toBe(`${FILES}?dir=a`);
    expect(router.state.historyAction).toBe("POP");
  });
});
