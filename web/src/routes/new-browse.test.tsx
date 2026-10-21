import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { browseCrumbs } from "@/components/new-space-browse";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import type { FolderBrowseResponse } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewRoute } from "./new";

// THE FOLDER BROWSER ON THE NEW PAGE (#467). The bridge resolves the field's text, walks up to the
// nearest folder that exists and filters by the rest (bridge/folder-browse.test.ts holds those rules
// against a real disk); the fake bridge below does the same over a small tree. The page's part: a
// Browse row under the field, a list that follows the field, a tap that moves the field, Up, the
// breadcrumb, Use this folder as a Recent tap, typing that narrows after a pause, and the one line
// for a text the bridge will not browse.

const HOME = "/home/you";

/** The fake disk: each folder's sub-folders, and which of them hold a `.git`. */
const TREE = new Map<string, readonly string[]>([
  [HOME, ["docs", "src"]],
  [`${HOME}/docs`, []],
  [`${HOME}/src`, ["collie", "plektra-api", "plektra-web"]],
  [`${HOME}/src/collie`, []],
  [`${HOME}/src/plektra-api`, []],
  [`${HOME}/src/plektra-web`, []],
]);
const GIT = new Set([`${HOME}/src/collie`, `${HOME}/src/plektra-api`]);

/** The bridge's answer for `text`, or `null` for its `unknown-path`. */
function answer(text: string, truncate: boolean): FolderBrowseResponse | null {
  const raw = text.trim();
  let abs = raw === "" || raw === "~" ? HOME : raw.startsWith("~/") ? `${HOME}/${raw.slice(2)}` : raw.startsWith("/") ? raw : `${HOME}/${raw}`;
  abs = abs.replace(/\/+$/u, "") || "/";
  if (abs !== HOME && !abs.startsWith(`${HOME}/`)) return null;
  const parts = abs.slice(HOME.length).split("/").filter(Boolean);
  for (let depth = parts.length; depth >= 0; depth--) {
    const path = [HOME, ...parts.slice(0, depth)].join("/");
    const subs = TREE.get(path);
    if (subs === undefined) continue;
    const filter = parts.slice(depth).join("/");
    const folders = subs.filter((n) => n.toLowerCase().startsWith(filter.toLowerCase())).map((name) => ({ name, git: GIT.has(`${path}/${name}`) }));
    const parent = depth === 0 ? null : [HOME, ...parts.slice(0, depth - 1)].join("/");
    return { path, parent, folders, filter, truncated: truncate };
  }
  return null;
}

interface FakeBridge {
  asked: string[];
  creates: unknown[];
}

function serveBridge(opts: { truncate?: boolean } = {}): FakeBridge {
  const bridge: FakeBridge = { asked: [], creates: [] };
  server.use(
    http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: HOME })),
    http.get("/api/folders", () => HttpResponse.json({ recent: [], favourites: [], home: HOME })),
    http.get("/api/folders/browse", ({ request }) => {
      const text = new URL(request.url).searchParams.get("path") ?? "";
      bridge.asked.push(text);
      const body = answer(text, opts.truncate === true);
      return body === null ? HttpResponse.json({ error: "unknown-path" }, { status: 404 }) : HttpResponse.json(body);
    }),
    http.post("/api/workspace", async ({ request }) => {
      bridge.creates.push(await request.json());
      return HttpResponse.json({ ok: true, pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: HOME } });
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

const dirField = () => screen.findByPlaceholderText("~ (home dir)");
const startButton = () => screen.getByRole("button", { name: "Start" });
const browseRow = () => screen.getByRole("button", { name: "Browse" });
const folderList = () => screen.findByRole("list", { name: "Folders" });
const rowNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));

describe("the New page: Browse", () => {
  it("opens on home, a tap descends and moves the field, Up ascends, and the git marker is a text badge", async () => {
    const user = userEvent.setup();
    const bridge = serveBridge();
    mount();
    const field = await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    // Nothing is read until the row is tapped.
    expect(bridge.asked).toEqual([]);
    expect(browseRow()).toHaveAttribute("aria-expanded", "false");
    expect(browseRow().className).toContain("min-h-11");

    await user.click(browseRow());
    expect(browseRow()).toHaveAttribute("aria-expanded", "true");
    let list = await folderList();
    expect(rowNames(list)).toEqual(["Open docs", "Open src"]);
    expect(bridge.asked).toEqual([""]);
    const crumbs = screen.getByRole("navigation", { name: "Folder path" });
    expect(within(crumbs).getByText("~")).toHaveAttribute("aria-current", "location");

    // A tap goes into the folder: the field follows, shortened with `~`.
    await user.click(within(list).getByRole("button", { name: "Open src" }));
    await waitFor(() => expect(field).toHaveValue("~/src"));
    await waitFor(async () => expect(rowNames(await folderList())).toContain("Open collie, a Git repository"));
    list = await folderList();
    expect(rowNames(list)).toEqual(["Up to ~", "Open collie, a Git repository", "Open plektra-api, a Git repository", "Open plektra-web"]);
    const collie = within(list).getByRole("button", { name: "Open collie, a Git repository" });
    expect(collie).toHaveTextContent("git");
    expect(collie.querySelector("[data-slot='badge']")).not.toBeNull();
    expect(within(list).getByRole("button", { name: "Open plektra-web" }).querySelector("[data-slot='badge']")).toBeNull();
    expect(collie.className).toContain("min-h-11");

    // Up goes to the parent, and the field follows.
    await user.click(within(list).getByRole("button", { name: "Up to ~" }));
    await waitFor(() => expect(field).toHaveValue("~"));
    await waitFor(async () => expect(rowNames(await folderList())).toEqual(["Open docs", "Open src"]));
    expect(bridge.creates).toEqual([]);
  });

  it("a crumb goes back up, and Use this folder fills the field, closes the list and moves on to Start", async () => {
    const user = userEvent.setup();
    const bridge = serveBridge();
    const router = mount();
    const field = await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.type(field, "~/src/collie");
    await user.click(browseRow());
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Folder path" })).toHaveTextContent("~/src/collie"));

    const crumbs = screen.getByRole("navigation", { name: "Folder path" });
    await user.click(within(crumbs).getByRole("button", { name: "src" }));
    await waitFor(() => expect(field).toHaveValue("~/src"));
    await waitFor(async () => expect(rowNames(await folderList())).toContain("Open plektra-web"));

    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(field).toHaveValue("~/src");
    await waitFor(() => expect(startButton()).toHaveFocus());
    expect(browseRow()).toHaveAttribute("aria-expanded", "false");
    // Nothing was created: the field is filled, as a Recent tap fills it.
    expect(bridge.creates).toEqual([]);
    expect(router.state.location.pathname).toBe("/new");
  });

  it("typing narrows the list after a pause: the nearest folder that exists, filtered by the rest", async () => {
    const user = userEvent.setup();
    const bridge = serveBridge();
    mount();
    const field = await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.click(browseRow());
    await folderList();

    await user.type(field, "~/src/PLE");
    await waitFor(async () => expect(rowNames(await folderList())).toEqual(["Up to ~", "Open plektra-api, a Git repository", "Open plektra-web"]));
    expect(screen.getByText("matching PLE")).toBeInTheDocument();
    // One read on open, then reads only after pauses: never one per keystroke.
    expect(bridge.asked.at(-1)).toBe("~/src/PLE");
    expect(bridge.asked.length).toBeLessThan(1 + "~/src/PLE".length);
    // The field stays exactly what was typed.
    expect(field).toHaveValue("~/src/PLE");
  });

  it("a text the bridge will not browse says one line and leaves the field alone", async () => {
    const user = userEvent.setup();
    serveBridge();
    mount();
    const field = await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.type(field, "/etc");
    await user.click(browseRow());
    expect(await screen.findByText("Nothing to browse here")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use this folder" })).toBeNull();
    expect(field).toHaveValue("/etc");
  });

  it("a cut listing says there is more and asks for more text", async () => {
    const user = userEvent.setup();
    serveBridge({ truncate: true });
    mount();
    await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.click(browseRow());
    expect(await screen.findByText("and more, type to narrow")).toBeInTheDocument();
  });

  it("a machine that predates the route says so instead of a list", async () => {
    const user = userEvent.setup();
    serveBridge();
    server.use(http.get("/api/folders/browse", () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    mount();
    await dirField();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await user.click(browseRow());
    expect(await screen.findByText("This machine runs an older Collie. Update this machine to browse its folders.")).toBeInTheDocument();
  });
});

describe("browseCrumbs", () => {
  it("is `~` and each folder below it, each one tap away", () => {
    expect(browseCrumbs(HOME, HOME)).toEqual([{ label: "~", text: "~" }]);
    expect(browseCrumbs(`${HOME}/src/app`, HOME)).toEqual([
      { label: "~", text: "~" },
      { label: "src", text: "~/src" },
      { label: "app", text: "~/src/app" },
    ]);
  });

  it("is one crumb that cannot be tapped when home does not shorten the path", () => {
    expect(browseCrumbs("/var/home/you/src", "")).toEqual([{ label: "/var/home/you/src", text: null }]);
  });
});
