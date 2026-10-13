import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetProgramLists } from "@/lib/conversation-list";
import { __resetOperatorCommands, getMuxConfig } from "@/lib/operator-config";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus } from "@/lib/status";
import type { AgentView, DurableConversationRow, MuxCapability, MuxConfig, WorkspaceView } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// THE DURABLE HOME (M53 spec 12), through the real home route: on a machine with no screen the Dashboard tab
// is the program's conversation list, drawn at once from the snapshot and filled in from the program's own
// list; every other machine keeps the dashboard it had.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

const pane = (paneId: string, title: string, over: Partial<AgentView> = {}): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "support",
  workspaceNumber: 1,
  tabId: `${paneId}:t`,
  agent: "pi",
  status: "idle",
  cwd: "",
  focused: false,
  paneLabel: title,
  ...over,
});

const NOW = Date.now();
const LIVE: AgentView[] = [
  pane("p1", "Refund for order 42", { status: "working", lastActiveAt: NOW - 60_000, subtitle: "checking the order" }),
  pane("p2", "Login fails on Safari", { status: "blocked", lastActiveAt: NOW - 120_000 }),
];
const SUPPORT: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "support",
  focused: true,
  activeTabId: "p1:t",
  tabCount: 2,
  paneCount: 2,
};
const ROWS: DurableConversationRow[] = [
  { id: "c1", title: "Refund for order 42", state: "open", paneId: "p1", items: 9, startedAt: "2026-10-13T08:00:00Z" },
  { id: "c2", title: "Login fails on Safari", state: "open", paneId: "p2", items: 4, startedAt: "2026-10-13T07:00:00Z" },
  { id: "c0", title: "Invoice address change", subtitle: "done by hand", state: "closed", items: 15, startedAt: "2026-10-12T08:00:00Z", endedAt: "2026-10-12T09:00:00Z" },
];

function homeData(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: LIVE,
    shellPanes: [],
    workspaces: [SUPPORT],
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
      { path: "/new", element: <div data-testid="new-page" /> },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
      { path: "/conversations/:id", element: <div data-testid="conversation" /> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

/** Serve the program's list, counting the reads. */
function serves(rows: DurableConversationRow[]) {
  const seen = { reads: 0 };
  server.use(
    http.get("/api/durable/conversations", () => {
      seen.reads += 1;
      return HttpResponse.json({ available: true, items: rows });
    }),
  );
  return seen;
}

const list = () => document.querySelector<HTMLElement>('[data-slot="conversation-list"]');
const rowTitles = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="conversation-row"]')].map(
    (row) => row.querySelector('[data-glide="name"]')?.textContent ?? "",
  );

beforeEach(() => {
  __resetOperatorCommands();
  __resetProgramLists();
});
afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
  __resetOperatorCommands();
  __resetProgramLists();
});

describe("durable home: the conversation list is the dashboard", () => {
  it("durable home: draws the live conversations from the snapshot, then the closed ones and the counts", async () => {
    declares({ paneGrid: false, programHistory: true });
    const seen = serves(ROWS);
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    // The open ones come from the snapshot, with their state, newest first.
    expect(rowTitles().slice(0, 2)).toEqual(["Refund for order 42", "Login fails on Safari"]);
    // The closed one and the counts come from the program's own list.
    await screen.findByText("Invoice address change");
    expect(rowTitles()).toEqual(["Refund for order 42", "Login fails on Safari", "Invoice address change"]);
    const rows = document.querySelectorAll<HTMLElement>('[data-slot="conversation-row"]');
    expect(rows[0]).toHaveAttribute("data-state", "working");
    expect(rows[0]).toHaveTextContent("checking the order");
    expect(rows[0]).toHaveTextContent("9 items");
    expect(rows[0]).toHaveTextContent("1m");
    expect(rows[0]!.querySelector('[role="progressbar"]')).toBeNull();
    expect(rows[1]).toHaveAttribute("data-state", "waiting");
    expect(rows[2]).toHaveAttribute("data-state", "closed");
    expect(rows[2]).toHaveTextContent("done by hand");
    expect(rows[2]).toHaveTextContent("15 items");
    // No terminal grid: no space navigator, no launch strip.
    expect(screen.queryByRole("button", { name: /^Spaces/ })).toBeNull();
    expect(seen.reads).toBe(1);
  });

  it("durable home: the waiting row carries the open-ask count, and the working row its hairline bar", async () => {
    declares({ paneGrid: false });
    const ask = { id: "a1", kind: "permission", toolCallId: "t1", revision: 1, title: "Refund it?", itemId: "i1", options: [] };
    const asking = pane("p2", "Login fails on Safari", { status: "blocked", asks: [ask, { ...ask, id: "a2" }] });
    const running = pane("p1", "Refund for order 42", {
      status: "working",
      lastActiveAt: NOW,
      progress: { kind: "steps", steps: [{ label: "look up", state: "done" }, { label: "refund", state: "running" }, { label: "reply", state: "todo" }] },
    });
    renderHome(homeData({ agents: [running, asking] }));
    await waitFor(() => expect(list()).not.toBeNull());
    const waiting = document.querySelector<HTMLElement>('[data-slot="conversation-row"][data-state="waiting"]')!;
    expect(within(waiting).getByText("2 open questions")).toBeInTheDocument();
    const working = document.querySelector<HTMLElement>('[data-slot="conversation-row"][data-state="working"]')!;
    // "Step 2 of 3" with the bar at one third: the bar fills by the one step that is done.
    expect(within(working).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33");
  });

  it("durable home: asks nothing of a program that keeps no list, and still lists its open conversations", async () => {
    declares({ paneGrid: false });
    const seen = serves(ROWS);
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    expect(rowTitles()).toEqual(["Refund for order 42", "Login fails on Safari"]);
    expect(seen.reads).toBe(0);
  });

  it("durable home: the New button stays, and opens the New page", async () => {
    declares({ paneGrid: false });
    const router = renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByTestId("new-page");
    expect(router.state.location.pathname).toBe("/new");
  });
});

describe("durable home: the conversation list's filter chips", () => {
  it("conversation list: All, Open, Needs you and Closed, with the Needs you count on its chip", async () => {
    declares({ paneGrid: false, programHistory: true });
    serves(ROWS);
    const user = userEvent.setup();
    renderHome(homeData());
    await screen.findByText("Invoice address change");
    const chips = screen.getByRole("radiogroup", { name: "Show conversations" });
    expect(within(chips).getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    expect(within(chips).getByRole("radio", { name: "Needs you, 1 needs you" })).toBeInTheDocument();

    await user.click(within(chips).getByRole("radio", { name: "Open" }));
    expect(rowTitles()).toEqual(["Refund for order 42", "Login fails on Safari"]);
    await user.click(within(chips).getByRole("radio", { name: /^Needs you/ }));
    expect(rowTitles()).toEqual(["Login fails on Safari"]);
    await user.click(within(chips).getByRole("radio", { name: "Closed" }));
    expect(rowTitles()).toEqual(["Invoice address change"]);
  });

  it("conversation list: a chip with nothing under it says so in words", async () => {
    declares({ paneGrid: false });
    const user = userEvent.setup();
    renderHome(homeData({ agents: [pane("p1", "Refund for order 42", { status: "working" })] }));
    await waitFor(() => expect(list()).not.toBeNull());
    await user.click(screen.getByRole("radio", { name: "Needs you" }));
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
  });
});

describe("durable home: the tap targets", () => {
  it("conversation list: a tap on an open row opens its pane", async () => {
    declares({ paneGrid: false, programHistory: true });
    serves(ROWS);
    const router = renderHome(homeData());
    await screen.findByText("Invoice address change");
    await userEvent.click(screen.getByRole("button", { name: /Login fails on Safari/ }));
    await screen.findByTestId("pane");
    expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent("p2")}`);
  });

  it("conversation list: a tap on a closed row opens the read-only view, which knows it is closed", async () => {
    declares({ paneGrid: false, programHistory: true });
    serves(ROWS);
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: /Invoice address change/ }));
    await screen.findByTestId("conversation");
    expect(router.state.location.pathname).toBe("/conversations/c0");
    expect(router.state.location.search).toBe("?state=closed");
  });
});

describe("durable home: every machine with a screen keeps its dashboard", () => {
  it("durable home: a Herdr machine draws its pane list and asks the program list nothing", async () => {
    declares({ paneGrid: true, programHistory: true });
    const seen = serves(ROWS);
    renderHome(homeData({ agents: fixtureAgents, shellPanes: fixtureShellPanes, workspaces: fixtureWorkspaces, tabs: fixtureTabs }));
    await screen.findByRole("button", { name: "New" });
    // Once the config has landed, the list must still not be there.
    await waitFor(() => expect(getMuxConfig()).not.toBeNull());
    expect(document.querySelector('[data-slot="conversation-list"]')).toBeNull();
    expect(screen.getAllByText(fixtureWorkspaces[0]!.label).length).toBeGreaterThan(0);
    expect(seen.reads).toBe(0);
  });
});
