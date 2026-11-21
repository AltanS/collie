import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { takeSidebarReveal } from "@/lib/new-over";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { withHeaderHost } from "@/test/header-host";
import { SpaceRoute } from "./space";

// THE SPACE ADDRESS ON A LARGE SCREEN (ADR 0173): `/space/:id` opens the pane view of the
// Space's open tab, at that tab's pane, with the sidebar reveal queued; a Space with no pane opens the
// Dashboard. On a phone the space page stays. The real sidebar scroll is in e2e/wide-new.spec.ts.

function windowOf(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  vi.stubGlobal("matchMedia", (query: string) => {
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    const matches = (minW === null || width >= Number(minW[1])) && (minH === null || height >= Number(minH[1]));
    // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false } as MediaQueryList;
  });
}

const workspaces: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "webapp", focused: false, activeTabId: "w1:t2", tabCount: 2, paneCount: 2 },
  { workspaceId: "w2", number: 2, label: "empty", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 0 },
];
const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "code", focused: false, paneCount: 1 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "review", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "main", focused: false, paneCount: 0 },
];
const pane = (paneId: string, tabId: string): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId,
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
});

function data(): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2")],
    shellPanes: [],
    workspaces,
    tabs,
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

function renderSpace(spaceId: string) {
  const d = data();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => d,
        children: [
          { index: true, element: <div data-testid="home" /> },
          {
            path: "space/:spaceId",
            element: withHeaderHost(
              <CrewProvider servers={d.servers} sessions={d.sessions} ts={d.ts} pollMs={1500}>
                <SpaceRoute />
              </CrewProvider>,
            ),
          },
        ],
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: ["/", `/space/${spaceId}`], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => __resetWideLayoutStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

describe("the space address", () => {
  it("opens the pane view of the open tab on a large screen, and queues the sidebar reveal", async () => {
    windowOf(1440, 900);
    const router = renderSpace("w1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap2"));
    expect(takeSidebarReveal("w1:p2")).toBe(true);
    // Sideways: the space address is replaced, Back goes to the Dashboard behind it.
    expect(router.state.historyAction).toBe("REPLACE");
    expect(document.querySelector('[data-slot="space-strip"]')).toBeNull();
  });

  it("opens the Dashboard for a Space with no pane, and draws no space page", async () => {
    windowOf(1440, 900);
    const router = renderSpace("w2");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(takeSidebarReveal("w1:p2")).toBe(false);
  });

  it("keeps the space page on a phone", async () => {
    windowOf(390, 844);
    const router = renderSpace("w1");
    await waitFor(() => expect(document.querySelector("main")).not.toBeNull());
    expect(router.state.location.pathname).toBe("/space/w1");
  });
});
