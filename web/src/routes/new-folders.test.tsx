import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewRoute } from "./new";

// FAVOURITE AND RECENT FOLDERS ON THE NEW PAGE (M40/02, issue 289). The cases were once a Playwright
// file (e2e/new-space-folders.spec.ts); none of them needs a real engine. The bridge keeps the lists
// and records Recent itself after a create that worked, so the fake bridge below does the same: the
// page's part is to read the list when it opens, offer each folder as a row that FILLS the Directory
// field, send the create exactly as before, and star a folder from one list into the other. The
// bridge's own recording rules are in bridge/folders.test.ts, and the read and the cache in
// lib/folders.test.ts. The 44px floor of a row and its star is a class check here; the pixels were
// the one thing jsdom cannot lay out.

const HOME = "/home/you";
const FOLDER = "/home/you/src/collie";
const SHOWN = "~/src/collie";

/** One bridge's folder list, mutated by a create and by a star as the real one is. */
interface FakeBridge {
  recent: string[];
  favourites: string[];
  creates: unknown[];
  stars: unknown[];
}

function serveBridge(): FakeBridge {
  const bridge: FakeBridge = { recent: [], favourites: [], creates: [], stars: [] };
  const list = () => ({ recent: bridge.recent, favourites: bridge.favourites, home: HOME });
  server.use(
    // A bridge before 1.19.0: no agent list, so Shell goes through the plain space create.
    http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: HOME })),
    http.get("/api/folders", () => HttpResponse.json(list())),
    http.post("/api/folders/star", async ({ request }) => {
      // SAFETY: the app's own `starFolder` posts exactly `{ folder, starred }`.
      const body = (await request.json()) as { folder: string; starred: boolean };
      bridge.stars.push(body);
      bridge.recent = bridge.recent.filter((f) => f !== body.folder);
      bridge.favourites = bridge.favourites.filter((f) => f !== body.folder);
      if (body.starred) bridge.favourites.push(body.folder);
      else bridge.recent.unshift(body.folder);
      return HttpResponse.json(list());
    }),
    http.post("/api/workspace", async ({ request }) => {
      // SAFETY: the app's own `createWorkspace` posts `{ label?, cwd? }`; only `cwd` is read here.
      const body = (await request.json()) as { cwd?: string };
      bridge.creates.push(body);
      if (body.cwd !== undefined && body.cwd !== "" && !bridge.favourites.includes(body.cwd)) {
        bridge.recent = [body.cwd, ...bridge.recent.filter((f) => f !== body.cwd)];
      }
      return HttpResponse.json({
        ok: true,
        pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: body.cwd ?? HOME },
      });
    }),
  );
  return bridge;
}

function homeData(): HomeData {
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
    error: false,
    authError: false,
  };
}

function mount() {
  const data = homeData();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...data }),
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
            <Outlet />
          </CrewProvider>,
        ),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewRoute /> },
          { path: "pane/:paneId", element: <div data-testid="pane" /> },
        ],
      },
    ],
    { initialEntries: ["/new"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
  __resetOperatorCommands();
});

const recent = () => screen.queryByRole("list", { name: "Recent" });
const favourites = () => screen.queryByRole("list", { name: "Favourites" });
const dirField = () => screen.findByPlaceholderText("~ (home dir)");
const startButton = () => screen.getByRole("button", { name: "Start" });
const useRow = (list: HTMLElement) => within(list).getByRole("button", { name: `Use ${SHOWN}` });

describe("the New page: favourite and recent folders", () => {
  it("shows a created folder under Recent next time, a star moves it, and a tap fills the field", async () => {
    const user = userEvent.setup();
    const bridge = serveBridge();

    // Nothing recorded yet: the page is the one that shipped before the list.
    let router = mount();
    const field = await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(recent()).toBeNull();
    expect(favourites()).toBeNull();

    // A create in a folder sends exactly what it always sent, and nothing about the list.
    await user.type(field, FOLDER);
    await user.click(startButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bridge.creates).toEqual([{ cwd: FOLDER }]);

    // The next time the page opens, the folder the bridge recorded is under Recent.
    cleanup();
    router = mount();
    const list = await screen.findByRole("list", { name: "Recent" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    const row = useRow(list);
    expect(row).toHaveTextContent("collie");
    expect(row).toHaveTextContent(SHOWN);

    // The row keeps the 44px floor and its star is a 44px square beside it.
    const star = within(list).getByRole("button", { name: `Add ${SHOWN} to favourites` });
    expect(row.className).toContain("min-h-11");
    expect(star.className).toContain("size-11");
    expect(row.parentElement).toBe(star.parentElement);

    // A star moves it to Favourites, pressed; Recent has nothing left to show.
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    const favs = await screen.findByRole("list", { name: "Favourites" });
    const unstar = within(favs).getByRole("button", { name: `Remove ${SHOWN} from favourites` });
    expect(unstar).toHaveAttribute("aria-pressed", "true");
    expect(bridge.stars).toEqual([{ folder: FOLDER, starred: true }]);
    await waitFor(() => expect(recent()).toBeNull());

    // A tap fills the field with the full path, moves on to Start, and creates nothing.
    await user.click(useRow(favs));
    expect(await dirField()).toHaveValue(FOLDER);
    await waitFor(() => expect(startButton()).toHaveFocus());
    expect(bridge.creates).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/new");

    // An unstar puts it back under Recent.
    await user.click(unstar);
    await waitFor(() => expect(favourites()).toBeNull());
    const back = await screen.findByRole("list", { name: "Recent" });
    expect(within(back).getAllByRole("listitem")).toHaveLength(1);
    expect(bridge.stars[1]).toEqual({ folder: FOLDER, starred: false });
  });

  it("sends a create in home with no folder, so there is nothing for the list to record", async () => {
    const user = userEvent.setup();
    const bridge = serveBridge();
    const router = mount();
    await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.click(startButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bridge.creates).toEqual([{}]);

    cleanup();
    mount();
    await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    expect(bridge.recent).toEqual([]);
    expect(recent()).toBeNull();
    expect(favourites()).toBeNull();
  });
});
