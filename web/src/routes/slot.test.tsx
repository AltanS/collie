import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, type RouteObject } from "react-router";

import { useSlotMemory } from "@/hooks/use-slot-memory";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { enterSlot } from "@/lib/slots";

import { RootLayout } from "./root";
import { SlotRoute } from "./slot";

// The route and the hook against a real (memory) router, on the window's own storages. A tab is one
// mount; a browser restart is `sessionStorage.clear()` with localStorage left as it is. The rules of
// what counts as a pane and as a slot number are pinned in lib/slots.test.ts.

function Page() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

function Layout() {
  useSlotMemory();
  return <Outlet />;
}

const PAGES = ["pane/:id", "pane/:id/history", "pane/:id/zoom", "pane/:id/changes", "settings", "space/:id"];

function mountTab(initialEntries: string[]) {
  const routes: RouteObject[] = [
    {
      path: "/",
      element: <Layout />,
      children: [
        { index: true, element: <Page /> },
        { path: "slot/:slot", element: <SlotRoute /> },
        ...PAGES.map((path) => ({ path, element: <Page /> })),
      ],
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries, initialIndex: initialEntries.length - 1 });
  const { unmount } = render(<RouterProvider router={router} />);
  const at = () => `${router.state.location.pathname}${router.state.location.search}`;
  const go = (to: string) => act(() => router.navigate(to));
  const back = () => act(() => router.navigate(-1));
  return { router, at, go, back, unmount };
}

async function settled(tab: ReturnType<typeof mountTab>, address: string) {
  await waitFor(() => expect(tab.at()).toBe(address));
}

/** Opens `/slot/<slot>` in a new tab, shows these pages in order, and closes the tab. */
async function workInSlot(slot: string, ...addresses: string[]) {
  const tab = mountTab([`/slot/${slot}`]);
  await waitFor(() => expect(tab.at()).not.toBe(`/slot/${slot}`));
  for (const address of addresses) await tab.go(address);
  tab.unmount();
}

function restartBrowser() {
  window.sessionStorage.clear();
}

/** Where a new tab goes for this slot; the tab is closed and its mark dropped afterwards. */
async function whereSlotLeads(slot: string) {
  restartBrowser();
  const tab = mountTab([`/slot/${slot}`]);
  await waitFor(() => expect(tab.at()).not.toBe(`/slot/${slot}`));
  const address = tab.at();
  tab.unmount();
  restartBrowser();
  return address;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("@oracle:requirement @req:SLOT-1 opening /slot/<n> with a stored address", () => {
  const ADDRESS = "/pane/w3%3Ap1?s=project-ss-form";

  it("lands on that exact address, the query included", async () => {
    await workInSlot("3", ADDRESS);
    restartBrowser();
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
    expect(tab.router.state.location.pathname).toBe("/pane/w3%3Ap1");
    expect(tab.router.state.location.search).toBe("?s=project-ss-form");
  });

  it("replaces the entry: back goes to the page before /slot/<n>, not to /slot/<n>", async () => {
    await workInSlot("3", ADDRESS);
    restartBrowser();
    const tab = mountTab(["/settings", "/slot/3"]);
    await settled(tab, ADDRESS);
    expect(tab.router.state.historyAction).toBe("REPLACE");
    await tab.back();
    await settled(tab, "/settings");
    // And it stays there: nothing bounced the tab forward again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(tab.at()).toBe("/settings");
  });

  it("adds no step of history: forward from the page before lands on the pane", async () => {
    await workInSlot("3", ADDRESS);
    restartBrowser();
    const tab = mountTab(["/settings", "/slot/3"]);
    await settled(tab, ADDRESS);
    await tab.back();
    await settled(tab, "/settings");
    await act(() => tab.router.navigate(1));
    await settled(tab, ADDRESS);
  });
});

describe("@oracle:requirement @req:SLOT-2 opening a slot never used", () => {
  it("lands on the home page, as a replace", async () => {
    const tab = mountTab(["/settings", "/slot/8"]);
    await settled(tab, "/");
    expect(tab.router.state.historyAction).toBe("REPLACE");
    await tab.back();
    await settled(tab, "/settings");
  });

  it("the tab still belongs to the slot: the first pane opened from home is stored", async () => {
    const tab = mountTab(["/slot/8"]);
    await settled(tab, "/");
    await tab.go("/pane/first?s=project");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("8")).toBe("/pane/first?s=project");
  });
});

describe("@oracle:requirement @req:SLOT-3 moving between panes in a slot tab", () => {
  it("updates that slot on each move, and other slots keep theirs", async () => {
    await workInSlot("1", "/pane/first");
    restartBrowser();
    const tab = mountTab(["/slot/2"]);
    await settled(tab, "/");
    await tab.go("/pane/a?s=one");
    await tab.go("/pane/b?s=two");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("2")).toBe("/pane/b?s=two");
    expect(await whereSlotLeads("1")).toBe("/pane/first");
  });

  it("follows a move that only changes the query", async () => {
    const tab = mountTab(["/slot/2"]);
    await settled(tab, "/");
    await tab.go("/pane/a?s=one");
    await tab.go("/pane/a?s=two");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("2")).toBe("/pane/a?s=two");
  });

  it("follows a move by back as well", async () => {
    const tab = mountTab(["/slot/2"]);
    await settled(tab, "/");
    await tab.go("/pane/a");
    await tab.go("/pane/b");
    await tab.back();
    await settled(tab, "/pane/a");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("2")).toBe("/pane/a");
  });
});

describe("@oracle:requirement @req:SLOT-4 the owner's five tiles through the route", () => {
  it("returns each tile to its own last pane after a restart", async () => {
    const lastOf = (slot: string) => `/pane/w${slot}%3Ap1?s=project-${slot}`;
    const SLOTS = ["1", "2", "3", "4", "5"];
    for (const slot of SLOTS) {
      await workInSlot(slot, `/pane/w${slot}%3Ap0`, lastOf(slot));
      restartBrowser();
    }
    for (const slot of SLOTS) expect(await whereSlotLeads(slot)).toBe(lastOf(slot));
  });
});

describe("@oracle:requirement @req:SLOT-5 a tab never opened through /slot", () => {
  it("changes no slot when it shows a pane", async () => {
    await workInSlot("1", "/pane/mine");
    restartBrowser();
    const tab = mountTab(["/pane/link?s=elsewhere"]);
    await settled(tab, "/pane/link?s=elsewhere");
    await tab.go("/pane/link-2");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("1")).toBe("/pane/mine");
    expect(await whereSlotLeads("2")).toBe("/");
  });
});

describe("@oracle:requirement @req:SLOT-6 pages that are not a pane page", () => {
  it("do not overwrite the stored address", async () => {
    await workInSlot("4", "/pane/last?s=project", "/", "/settings", "/pane/x/history", "/pane/x/zoom", "/pane/x/changes", "/space/w1");
    restartBrowser();
    expect(await whereSlotLeads("4")).toBe("/pane/last?s=project");
  });
});

describe("@oracle:requirement @req:SLOT-7 an invalid slot number", () => {
  it.each(["0", "100", "abc", "01", "1x"])("/slot/%s lands home and marks nothing", async (raw) => {
    await workInSlot("1", "/pane/mine");
    restartBrowser();
    const tab = mountTab([`/slot/${raw}`]);
    await settled(tab, "/");
    await tab.go("/pane/later");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("1")).toBe("/pane/mine");
    expect(await whereSlotLeads("2")).toBe("/");
  });
});

describe("@oracle:requirement @req:SLOT-8 stored data that cannot be trusted", () => {
  it("lands home on the route as well", async () => {
    await workInSlot("3", "/pane/good");
    restartBrowser();
    for (let idx = 0; idx < window.localStorage.length; idx += 1) {
      const key = window.localStorage.key(idx);
      if (key !== null) window.localStorage.setItem(key, "{broken");
    }
    expect(await whereSlotLeads("3")).toBe("/");
  });
});

describe("@oracle:requirement @req:SLOT-10 a tab in one slot that opens another", () => {
  it("lands on the new slot's address and stores later panes there only", async () => {
    await workInSlot("2", "/pane/two");
    restartBrowser();
    const tab = mountTab(["/slot/1"]);
    await settled(tab, "/");
    await tab.go("/pane/one");
    await tab.go("/slot/2");
    await settled(tab, "/pane/two");
    await tab.go("/pane/moved");
    tab.unmount();
    restartBrowser();
    expect(await whereSlotLeads("2")).toBe("/pane/moved");
    expect(await whereSlotLeads("1")).toBe("/pane/one");
  });
});

// The two wirings a small test layout cannot see: the feature is dead without either one.
describe("the application's own wiring", () => {
  function emptyHome(): HomeData {
    return {
      bridge: "connected",
      device: undefined,
      agents: [],
      shellPanes: [],
      workspaces: [],
      tabs: [],
      sessions: [],
      servers: [],
      ts: 0,
      scope: {},
      viewAll: false,
      snoozedUntil: null,
      update: undefined,
      error: true,
      authError: false,
    };
  }

  it("@oracle:requirement @req:SLOT-3 the root layout stores the pane a slot tab shows", async () => {
    enterSlot("7");
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: emptyHome,
          element: <RootLayout />,
          children: [{ path: "pane/:id", element: <Page /> }],
        },
      ],
      { initialEntries: ["/pane/via-root?s=project"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.initialized).toBe(true));
    await waitFor(() => {
      window.sessionStorage.clear();
      expect(enterSlot("7")).toBe("/pane/via-root?s=project");
    });
  });

  it("@oracle:requirement @req:SLOT-1 the router has the route, with SlotRoute as its element", async () => {
    window.history.replaceState(null, "", "/settings");
    vi.resetModules();
    const { router } = await import("@/router");
    const slotModule = await import("./slot");
    type Route = { path?: string; element?: unknown; children?: Route[] };
    const flatten = (routes: Route[]): Route[] => routes.flatMap((route) => [route, ...flatten(route.children ?? [])]);
    const route = flatten(router.routes).find((candidate) => candidate.path === "slot/:slot");
    expect(route).toBeDefined();
    expect(route?.element).toMatchObject({ type: slotModule.SlotRoute });
    router.dispose();
    window.history.replaceState(null, "", "/");
    // A fresh import of the whole application: 11 s measured on a loaded host.
  }, 120_000);
});
