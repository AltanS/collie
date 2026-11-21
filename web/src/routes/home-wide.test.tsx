import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { t } from "@/lib/i18n";
import { __resetPairing, markNotPaired } from "@/lib/pairing";
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
  __resetPairing();
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

// THE HEADER, THE COMMAND ROW AND THE EMPTY STATES ON A LARGE SCREEN (ADR 0158, addendum 2026-11-21): no tab bar
// at the foot, the views in the header, New at the end of the sticky command row, and every empty state one
// centred column with nothing beside it. The geometry (centred within 1px, the 48px header, the sticky row) is
// in e2e/dashboard-wide-head.spec.ts.
const views = () => document.querySelector<HTMLElement>('[data-slot="dashboard-views"]');
const footBar = () => screen.queryByRole("navigation", { name: t("home.tabs.aria") });
const commandRow = () => document.querySelector<HTMLElement>('[data-slot="wide-command-row"]');
const centredMain = () => document.querySelector("main.justify-center");
const spacesSection = () => screen.queryByRole("button", { name: /^Spaces/u });

describe("the large-screen dashboard's header and command row", () => {
  it("draws the views in the header and New at the end of the command row, with no tab bar and no floating button", async () => {
    windowOf(1280, 800);
    renderHome(homeData());
    await waitFor(() => expect(commandRow()).not.toBeNull());
    expect(views()).not.toBeNull();
    expect(views()!.closest('[data-slot="app-header"]')).not.toBeNull();
    const tabs = within(views()!).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([expect.stringContaining(t("home.tabs.dashboard")), t("files.title")]);
    expect(footBar()).toBeNull();
    expect(within(commandRow()!).getByRole("button", { name: t("home.new.label") })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="fab-layer"]')).toBeNull();
    // The header spans the window on the recess; only its row keeps the grid's width.
    const header = document.querySelector<HTMLElement>('[data-slot="app-header"]')!;
    expect(header.className).toContain("bg-surface-recess");
    expect(header.style.maxWidth).toBe("");
    expect(document.querySelector<HTMLElement>('[data-slot="header-row"]')!.className).toContain("min-h-12");
  });

  it("keeps the phone's tab bar, its floating New button and its 60px header on a phone", async () => {
    windowOf(390, 844);
    renderHome(homeData());
    await screen.findByRole("heading", { name: "webapp" });
    expect(views()).toBeNull();
    expect(commandRow()).toBeNull();
    expect(footBar()).not.toBeNull();
    expect(document.querySelector('[data-slot="fab-layer"]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="header-row"]')!.className).toContain("min-h-15");
  });
});

describe("the large-screen dashboard's empty states", () => {
  it("not paired: one centred block, no strip that says it again, no Spaces section", async () => {
    windowOf(1280, 800);
    act(() => markNotPaired());
    renderHome(homeData({ agents: [], shellPanes: [], workspaces: [], tabs: [], error: true }));
    await screen.findByText(t("settings.devices.pair.title"));
    expect(screen.getByText("collie pair")).toBeInTheDocument();
    expect(centredMain()).not.toBeNull();
    expect(screen.queryByText(t("space.readOnly.notPaired"))).toBeNull();
    expect(spacesSection()).toBeNull();
    expect(footBar()).toBeNull();
  });

  it("paired with no Spaces: the first-start card is the one way in, centred, with no New beside it", async () => {
    windowOf(1280, 800);
    renderHome(homeData({ agents: [], shellPanes: [], workspaces: [], tabs: [] }));
    await screen.findByText(t("newPage.first.title"));
    expect(centredMain()).not.toBeNull();
    expect(screen.queryByRole("button", { name: t("home.new.label") })).toBeNull();
    expect(document.querySelector('[data-slot="fab-layer"]')).toBeNull();
    expect(spacesSection()).toBeNull();
  });

  it("offline with nothing saved: one centred line, no Spaces section", async () => {
    windowOf(1280, 800);
    renderHome(homeData({ agents: [], shellPanes: [], workspaces: [], tabs: [], error: true, bridge: undefined }));
    await screen.findByText(t("home.empty.disconnected"));
    expect(centredMain()).not.toBeNull();
    expect(spacesSection()).toBeNull();
  });

  it("waiting for the first answer: one centred line", async () => {
    windowOf(1280, 800);
    renderHome(homeData({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: undefined }));
    await screen.findByText(t("home.empty.waiting"));
    expect(centredMain()).not.toBeNull();
  });

  it("keeps the phone's empty dashboard on a phone: the strip, the Spaces section, the top-weighted block", async () => {
    windowOf(390, 844);
    act(() => markNotPaired());
    renderHome(homeData({ agents: [], shellPanes: [], workspaces: [], tabs: [], error: true }));
    await screen.findByText(t("settings.devices.pair.title"));
    expect(screen.getByText(t("space.readOnly.notPaired"))).toBeInTheDocument();
    expect(centredMain()).toBeNull();
  });
});
