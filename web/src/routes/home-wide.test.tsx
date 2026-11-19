import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { HomeRoute } from "./home";

// THE HOME ROUTE ON A LARGE SCREEN (ADR 0158): the expanded width class with Large-screen layout not Off
// mounts the grid and its band; the phone, the medium class and Off mount the phone's list, unchanged. The
// real columns and the real overflow are in e2e/dashboard-wide.spec.ts; jsdom has no layout.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

/** A window of this size, as the two media queries of the width class read it. */
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

function homeData(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    workspaces: fixtureWorkspaces,
    tabs: fixtureTabs,
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...over,
  };
}

function renderHome(data: HomeData) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <HomeRoute />
          </CrewProvider>,
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

const wideList = () => document.querySelector('[data-slot="wide-dashboard"]');
const band = () => document.querySelector<HTMLElement>('[data-slot="wide-waiting"]');

beforeEach(() => __resetWideLayoutStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

describe("which dashboard the home route mounts", () => {
  it("mounts the grid in the expanded class", async () => {
    windowOf(1280, 800);
    renderHome(homeData());
    await waitFor(() => expect(wideList()).not.toBeNull());
    expect(document.querySelector('[data-slot="wide-rows"]')).not.toBeNull();
    // The route is no longer the phone's 640px column.
    expect(document.querySelector(".max-w-screen-sm.flex-1")).toBeNull();
  });

  it("mounts the phone's list on a phone and in the medium class, in the phone's 640px column", async () => {
    for (const [w, h] of [[390, 844], [700, 900]] as const) {
      windowOf(w, h);
      renderHome(homeData());
      await screen.findByRole("heading", { name: "webapp" });
      expect(wideList()).toBeNull();
      expect(band()).toBeNull();
      expect(document.querySelector('[data-slot="wide-rows"]')).toBeNull();
      expect(document.querySelector(".mx-auto.max-w-screen-sm.flex-1")).not.toBeNull();
      cleanup();
    }
  });

  it("mounts the phone's list at 1280 with Large-screen layout Off", async () => {
    windowOf(1280, 800);
    act(() => setWideLayoutMode("off"));
    renderHome(homeData());
    await screen.findByRole("heading", { name: "webapp" });
    expect(wideList()).toBeNull();
    expect(document.querySelector(".mx-auto.max-w-screen-sm.flex-1")).not.toBeNull();
  });

  it("mounts the phone's list in a short window, a phone held sideways", async () => {
    windowOf(900, 400);
    renderHome(homeData());
    await screen.findByRole("heading", { name: "webapp" });
    expect(wideList()).toBeNull();
  });
});

describe("the band on the large screen", () => {
  it("shows a session that needs you, and the same session keeps its row in its Space", async () => {
    windowOf(1280, 800);
    renderHome(homeData());
    await waitFor(() => expect(band()).not.toBeNull());
    // fixtureAgents: the webapp agent is blocked, the collie agent is working.
    const card = within(band()!).getByRole("button", { name: /claude/u });
    expect(card).toBeInTheDocument();
    expect(within(band()!).queryByRole("button", { name: /codex/u })).toBeNull();
    const space = document.querySelector<HTMLElement>('[data-space$="w1"]')!;
    expect(within(space).getByRole("button", { name: /claude/u })).toBeInTheDocument();
    // The row has the pane's DOM id; the band's card has none, so no id is repeated.
    const ids = [...document.querySelectorAll("[id^='pane-row-']")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is absent with nothing waiting", async () => {
    windowOf(1280, 800);
    renderHome(homeData({ agents: fixtureAgents.map((a) => Object.assign(structuredClone(a), { status: "working" as const })) }));
    await waitFor(() => expect(wideList()).not.toBeNull());
    expect(band()).toBeNull();
  });

  it("is in the first render when the saved copy says a session waits, already open", () => {
    windowOf(1280, 800);
    renderHome(homeData({ stale: true, error: true, lastSeenAt: 1 }));
    // No awaiting: the first commit has it, through a Collapse that mounted open.
    return waitFor(() => {
      expect(band()).not.toBeNull();
      expect(band()!.closest('[data-slot="collapse"]')!.getAttribute("data-state")).toBe("open");
    });
  });
});
