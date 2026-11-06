import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, type RouteObject } from "react-router";

import { useSlotMemory } from "@/hooks/use-slot-memory";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { enterSlot, rememberSlotPane, slotSpace } from "@/lib/slots";
import type { SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureSnapshot } from "@/test/handlers";

import { RootLayout } from "./root";
import { SlotRoute } from "./slot";

const { fetchSnapshot } = vi.hoisted(() => ({ fetchSnapshot: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSnapshot,
}));

// The route and the hook against a real (memory) router, on the window's own storages. A tab is one
// mount; a browser restart is `sessionStorage.clear()` with localStorage left as it is. The rules of
// what counts as a pane and as a slot number are pinned in lib/slots.test.ts.

/** Every address a page of the test layout has drawn, in order. */
const drawn: string[] = [];

function Page() {
  const location = useLocation();
  drawn.push(`${location.pathname}${location.search}`);
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
  drawn.length = 0;
  fetchSnapshot.mockReset();
  fetchSnapshot.mockRejectedValue(new Error("this case has no snapshot"));
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

// A pane id is unique only within one bridge process, and a slot outlives that process: a stored pane
// id can name another project's pane now. The stored workspace name tells them apart.
describe("@oracle:requirement @req:SLOT-11 a stored pane whose id may have been reused", () => {
  const PATH = "/pane/w3%3Ap1";
  const ADDRESS = `${PATH}?s=project-x`;
  const PANE_ID = "w3:p1";
  const SCOPED_HOME = "/?s=project-x";

  function store(slot: string, address: string, space?: string) {
    const at = address.indexOf("?");
    enterSlot(slot);
    rememberSlotPane(at === -1 ? address : address.slice(0, at), at === -1 ? "" : address.slice(at), undefined, undefined, space);
    restartBrowser();
  }

  function snapshotWith(paneId: string, workspaceLabel: string): SnapshotResponse {
    return {
      ...fixtureSnapshot,
      agents: [{ ...fixtureAgents[0]!, paneId, workspaceLabel }],
      shellPanes: [],
    };
  }

  function shellSnapshotWith(paneId: string, workspaceLabel: string): SnapshotResponse {
    return {
      ...fixtureSnapshot,
      agents: [],
      shellPanes: [{ ...fixtureShellPanes[0]!, paneId, workspaceLabel }],
    };
  }

  function expectNeverOnPane() {
    expect(drawn.filter((address) => address.startsWith("/pane/"))).toEqual([]);
  }

  it("a) the pane is in the same workspace: lands on the pane address", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
  });

  it("a) the same for a shell pane", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(shellSnapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
  });

  it("a) the wait adds no step of history: back goes to the page before the slot", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/settings", "/slot/3"]);
    await settled(tab, ADDRESS);
    await tab.back();
    await settled(tab, "/settings");
  });

  it("b) the pane is in another workspace: lands on home of that scope, not on the pane", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "B"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, SCOPED_HOME);
    expectNeverOnPane();
  });

  it("b) the same for a shell pane", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(shellSnapshotWith(PANE_ID, "B"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, SCOPED_HOME);
    expectNeverOnPane();
  });

  it("b) home of an address with no query is the plain home", async () => {
    store("3", PATH, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "B"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, "/");
    expectNeverOnPane();
  });

  it("b) home keeps the machine and the session of the stored address", async () => {
    store("3", `${PATH}?h=peer&s=project-x`, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "B"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, "/?h=peer&s=project-x");
    expectNeverOnPane();
  });

  it("b) never on the wrong pane for a moment: nothing leaves /slot/n before the answer", async () => {
    store("3", ADDRESS, "A");
    let answer: (snapshot: SnapshotResponse) => void = () => undefined;
    fetchSnapshot.mockReturnValue(
      new Promise<SnapshotResponse>((resolve) => {
        answer = resolve;
      }),
    );
    const tab = mountTab(["/settings", "/slot/3"]);
    const visited: string[] = [];
    tab.router.subscribe((state) => visited.push(`${state.location.pathname}${state.location.search}`));
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalled());
    expect(tab.at()).toBe("/slot/3");
    expectNeverOnPane();

    await act(async () => answer(snapshotWith(PANE_ID, "B")));
    await settled(tab, SCOPED_HOME);
    expectNeverOnPane();
    expect(visited.filter((address) => address.startsWith("/pane/"))).toEqual([]);
    await tab.back();
    await settled(tab, "/settings");
  });

  it("b) the tab still belongs to the slot: the next pane it shows is stored", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "B"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, SCOPED_HOME);
    await tab.go("/pane/next?s=project-x");
    tab.unmount();
    restartBrowser();
    fetchSnapshot.mockClear();
    expect(await whereSlotLeads("3")).toBe("/pane/next?s=project-x");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("a restored pane keeps its name: the id reused before the next restart is still caught", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const first = mountTab(["/slot/3"]);
    await settled(first, ADDRESS);
    first.unmount();
    restartBrowser();
    drawn.length = 0;
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "B"));
    const second = mountTab(["/slot/3"]);
    await settled(second, SCOPED_HOME);
    expectNeverOnPane();
  });

  it("c) the snapshot lacks the pane: lands on the pane address", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith("w9:p9", "A"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
  });

  it("d) the snapshot fails: lands on the pane address", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockRejectedValue(new Error("bridge is down"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
  });

  it("e) a pane stored with no name: lands on the pane address without asking for a snapshot", async () => {
    store("3", ADDRESS);
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("e) a slot never used and an invalid slot ask for no snapshot", async () => {
    const unused = mountTab(["/slot/3"]);
    await settled(unused, "/");
    unused.unmount();
    const invalid = mountTab(["/slot/abc"]);
    await settled(invalid, "/");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("f) the snapshot is asked with the scope of the stored address", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, ADDRESS);
    expect(fetchSnapshot.mock.calls[0]?.[0]).toMatchObject({ session: "project-x" });
  });

  it("f) not with the scope of /slot/n", async () => {
    store("3", ADDRESS, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/slot/3?s=other&h=elsewhere"]);
    await settled(tab, ADDRESS);
    const scope: unknown = fetchSnapshot.mock.calls[0]?.[0];
    expect(scope).toMatchObject({ session: "project-x" });
    expect(scope).not.toMatchObject({ host: "elsewhere" });
  });

  it("f) the machine of the stored address goes with it", async () => {
    store("3", `${PATH}?h=peer&s=project-x`, "A");
    fetchSnapshot.mockResolvedValue(snapshotWith(PANE_ID, "A"));
    const tab = mountTab(["/slot/3"]);
    await settled(tab, `${PATH}?h=peer&s=project-x`);
    expect(fetchSnapshot.mock.calls[0]?.[0]).toMatchObject({ host: "peer", session: "project-x" });
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

  describe("@oracle:requirement @req:SLOT-11 the root layout gives the pane's workspace name", () => {
    const PATH = "/pane/w1%3Ap1";
    const ADDRESS = `${PATH}?s=project`;
    const holding = (workspaceLabel: string): Partial<HomeData> => ({
      agents: [{ ...fixtureAgents[0]!, paneId: "w1:p1", workspaceLabel }],
      error: false,
    });

    function mountRoot(initial: string, first: Partial<HomeData>) {
      enterSlot("7");
      let data: HomeData = { ...emptyHome(), ...first };
      const router = createMemoryRouter(
        [
          {
            id: ROOT_ROUTE_ID,
            path: "/",
            loader: () => data,
            element: <RootLayout />,
            children: [{ path: "pane/:id", element: <Page /> }],
          },
        ],
        { initialEntries: [initial] },
      );
      render(<RouterProvider router={router} />);
      return {
        router,
        async answer(next: Partial<HomeData>) {
          data = { ...emptyHome(), ...next };
          await act(async () => {
            router.revalidate();
          });
          await waitFor(() => expect(router.state.revalidation).toBe("idle"));
        },
      };
    }

    /** The address has reached the slot, so what the name says now is what the hook decided. */
    async function addressStored(address: string) {
      await waitFor(() => expect(enterSlot("7")).toBe(address));
    }

    it("stores the name when the root data holds the pane among the agents", async () => {
      mountRoot(ADDRESS, holding("A"));
      await waitFor(() => expect(slotSpace("7")).toBe("A"));
    });

    it("stores the name when the root data holds the pane among the shell panes", async () => {
      mountRoot(ADDRESS, {
        agents: [],
        shellPanes: [{ ...fixtureShellPanes[0]!, paneId: "w1:p1", workspaceLabel: "S" }],
        error: false,
      });
      await waitFor(() => expect(slotSpace("7")).toBe("S"));
    });

    it("stores no name from data that has an error", async () => {
      mountRoot(ADDRESS, { ...holding("A"), error: true });
      await addressStored(ADDRESS);
      expect(slotSpace("7")).toBeUndefined();
    });

    it("stores no name when the data does not hold the pane", async () => {
      mountRoot(ADDRESS, { agents: [{ ...fixtureAgents[0]!, paneId: "w9:p9", workspaceLabel: "Z" }], error: false });
      await addressStored(ADDRESS);
      expect(slotSpace("7")).toBeUndefined();
    });

    it("stores the name when the data comes to hold the pane later", async () => {
      const root = mountRoot(ADDRESS, { error: false });
      await addressStored(ADDRESS);
      expect(slotSpace("7")).toBeUndefined();
      await root.answer(holding("A"));
      await waitFor(() => expect(slotSpace("7")).toBe("A"));
    });

    it("keeps the name when later data no longer holds the pane or has an error", async () => {
      const root = mountRoot(ADDRESS, holding("A"));
      await waitFor(() => expect(slotSpace("7")).toBe("A"));
      await root.answer({ error: false });
      expect(slotSpace("7")).toBe("A");
      await root.answer({ ...holding("Z"), error: true });
      expect(slotSpace("7")).toBe("A");
    });

    it("follows the name when the pane moves to another workspace", async () => {
      const root = mountRoot(ADDRESS, holding("A"));
      await waitFor(() => expect(slotSpace("7")).toBe("A"));
      await root.answer(holding("B"));
      await waitFor(() => expect(slotSpace("7")).toBe("B"));
    });

    it("drops the name on a move to a pane the data does not hold", async () => {
      const root = mountRoot(ADDRESS, holding("A"));
      await waitFor(() => expect(slotSpace("7")).toBe("A"));
      await act(() => root.router.navigate("/pane/elsewhere"));
      await addressStored("/pane/elsewhere");
      expect(slotSpace("7")).toBeUndefined();
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
