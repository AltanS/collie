import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { PaneChangesResponse } from "@/lib/types";
import { fixtureAgents, fixtureChanges } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { ChangesRoute } from "./changes";

const connected = (): HomeData => ({
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  sessions: [],
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => connected(),
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div /> },
          { path: "pane/:paneId", element: <div>pane screen</div> },
          { path: "pane/:paneId/changes", element: <ChangesRoute /> },
          { path: "space/:spaceId", element: <div>space screen</div> },
          { path: "space/:spaceId/changes", element: <ChangesRoute /> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => localStorage.clear());

describe("ChangesRoute — the list", () => {
  it("groups files by repo and names each repo when there are two", async () => {
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(screen.getByText("api · 2 files")).toBeTruthy();
    const api = screen.getByRole("region", { name: "api" });
    expect(within(api).getByText("orders.ts")).toBeTruthy();
    expect(within(api).getByText("server/handlers/")).toBeTruthy();
    expect(within(api).getByText(en["changes.status.untracked"])).toBeTruthy();
    expect(screen.getByText(en["changes.binaryShort"])).toBeTruthy();
  });

  it("names the workspace and its folder in the header", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ ...fixtureChanges, workspaceLabel: "collie-workspace", root: "/home/you/projects/collie-workspace" }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("collie-workspace")).toBeTruthy();
    const folder = screen.getByText("…/projects/collie-workspace");
    expect(folder.getAttribute("title")).toBe("/home/you/projects/collie-workspace");
  });

  it("the space form asks by workspace, shows the same list, and goes back to the space", async () => {
    const asked: string[] = [];
    server.use(
      // Records the ask and falls through to the shared handler, which answers list and diff.
      http.get(/\/api\/workspace\/[^/]+\/changes/, ({ request }) => {
        asked.push(new URL(request.url).pathname);
      }),
    );
    const router = renderAt("/space/w1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(asked[0]).toBe("/api/workspace/w1/changes");
    await userEvent.click(await screen.findByRole("button", { name: /checkout\.tsx/ }));
    expect(router.state.location.pathname).toBe("/space/w1/changes");
    expect(router.state.location.search).toBe("?repo=.&path=src%2Froutes%2Fcheckout.tsx");
    await userEvent.click(screen.getByRole("button", { name: en["changes.listBackAria"] }));
    await userEvent.click(await screen.findByRole("button", { name: en["changes.backSpaceAria"] }));
    expect(await screen.findByText("space screen")).toBeTruthy();
  });

  it("explains a workspace that is gone", async () => {
    server.use(
      http.get(/\/api\/workspace\/[^/]+\/changes/, () =>
        HttpResponse.json({ workspaceId: "w9", available: false, reason: "no-workspace" }),
      ),
    );
    renderAt("/space/w9/changes");
    expect(await screen.findByText(en["changes.unavailable.noWorkspace"])).toBeTruthy();
  });

  it("hides the repo heading when only one repo has changes", async () => {
    const one: PaneChangesResponse = fixtureChanges.available
      ? { ...fixtureChanges, repos: fixtureChanges.repos.slice(0, 1) }
      : fixtureChanges;
    server.use(http.get(/\/api\/pane\/[^/]+\/changes/, () => HttpResponse.json(one)));
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("checkout.tsx")).toBeTruthy();
    expect(screen.queryByText(/webapp ·/)).toBeNull();
  });

  it("says so when nothing changed, and when the pane has no folder", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: true, root: "/x", repos: [], truncated: false }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.empty"])).toBeTruthy();
  });

  it("explains a pane with no folder", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-folder" }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.unavailable.noFolder"])).toBeTruthy();
  });

  it("sends the depth and nested choices from Settings, and refetches on refresh", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesNested: false, changesDepth: 3 }));
    const seen: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(fixtureChanges);
      }),
    );
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    expect(seen).toEqual(["?depth=3&nested=0"]);
    await userEvent.click(screen.getByRole("button", { name: en["changes.refreshAria"] }));
    await waitFor(() => expect(seen).toHaveLength(2));
  });
});

describe("ChangesRoute — one file", () => {
  it("opens a file's diff, walks Next across repos, and goes back to the list", async () => {
    const router = renderAt("/pane/w1%3Ap1/changes");
    await userEvent.click(await screen.findByRole("button", { name: /checkout\.tsx/ }));
    expect(await screen.findByText("const total = cartTotal(cart.items);")).toBeTruthy();
    expect(router.state.location.search).toBe("?repo=.&path=src%2Froutes%2Fcheckout.tsx");
    // First file: Previous is disabled, never hidden.
    expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    expect(await screen.findByText("export function cartTotal(items: { price: number }[]): number {")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    expect(await screen.findByText(en["changes.file.binary"])).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    // Across the repo boundary, into `packages/api`, and the rename names where it came from.
    expect(await screen.findByText("Renamed from server/orders.ts")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: en["changes.listBackAria"] }));
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(router.state.location.search).toBe("");
  });

  it("a deep link to a file still gets Previous / Next once the list lands", async () => {
    renderAt("/pane/w1%3Ap1/changes?repo=packages%2Fapi&path=notes.md");
    expect(await screen.findByText("Orders moved under handlers/.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: /Next file/ }).hasAttribute("disabled")).toBe(true);
  });
});
