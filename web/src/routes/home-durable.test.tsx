import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetProgramLists } from "@/lib/conversation-list";
import { __resetOperatorCommands, getMuxConfig } from "@/lib/operator-config";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetSessionCards, noteSessionCards } from "@/lib/session-cards";
import { clearStatus } from "@/lib/status";
import type { AgentView, DurableConversationRow, MuxCapability, MuxConfig, WorkspaceView } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// THE DURABLE HOME (M53 spec 12, simplified in durable-simple), through the real home route: on a machine with no screen the Dashboard tab
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
  __resetSessionCards();
});

describe("durable home: the conversation list is the dashboard", () => {
  it("durable home: draws the live conversations from the snapshot, then the closed ones under their label", async () => {
    declares({ paneGrid: false, programHistory: true });
    const seen = serves(ROWS);
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    // The open ones come from the snapshot, with their state: what waits on you first, then newest first.
    expect(rowTitles().slice(0, 2)).toEqual(["Login fails on Safari", "Refund for order 42"]);
    // The closed one comes from the program's own list, under its own label.
    await screen.findByText("Invoice address change");
    expect(rowTitles()).toEqual(["Login fails on Safari", "Refund for order 42", "Invoice address change"]);
    const rows = document.querySelectorAll<HTMLElement>('[data-slot="conversation-row"]');
    expect(rows[0]).toHaveAttribute("data-state", "waiting");
    expect(rows[1]).toHaveAttribute("data-state", "working");
    expect(rows[1]).toHaveTextContent("checking the order");
    expect(rows[1]).toHaveTextContent("1m");
    expect(rows[1]).not.toHaveTextContent("9 items");
    expect(rows[1]!.querySelector('[role="progressbar"]')).toBeNull();
    expect(rows[2]).toHaveAttribute("data-state", "closed");
    expect(rows[2]).toHaveTextContent("done by hand");
    const closed = document.querySelector<HTMLElement>('[data-slot="conversation-closed"]')!;
    expect(closed.firstElementChild).toHaveTextContent(/^Closed$/);
    expect(within(closed).getByText("Invoice address change")).toBeInTheDocument();
    // No terminal grid: no space navigator, no launch strip.
    expect(screen.queryByRole("button", { name: /^Spaces/ })).toBeNull();
    expect(seen.reads).toBe(1);
  });

  it("durable home: the waiting row carries the open-ask count and its question, and a working row draws no bar", async () => {
    declares({ paneGrid: false });
    const ask = { id: "a1", kind: "permission", toolCallId: "t1", revision: 1, title: "Refund it?", itemId: "i1", options: [] };
    const asking = pane("p2", "Login fails on Safari", { status: "blocked", subtitle: "Safari only", asks: [ask, { ...ask, id: "a2" }] });
    const running = pane("p1", "Refund for order 42", {
      status: "working",
      lastActiveAt: NOW,
      progress: { kind: "steps", steps: [{ label: "look up", state: "done" }, { label: "refund", state: "running" }, { label: "reply", state: "todo" }] },
    });
    renderHome(homeData({ agents: [running, asking] }));
    await waitFor(() => expect(list()).not.toBeNull());
    const waiting = document.querySelector<HTMLElement>('[data-slot="conversation-row"][data-state="waiting"]')!;
    expect(within(waiting).getByText("2 open questions")).toBeInTheDocument();
    expect(waiting.querySelector('[data-slot="conversation-line"]')).toHaveTextContent("Refund it?");
    const working = document.querySelector<HTMLElement>('[data-slot="conversation-row"][data-state="working"]')!;
    expect(within(working).queryByRole("progressbar")).toBeNull();
  });

  it("durable home: asks nothing of a program that keeps no list, and still lists its open conversations", async () => {
    declares({ paneGrid: false });
    const seen = serves(ROWS);
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    expect(rowTitles()).toEqual(["Login fails on Safari", "Refund for order 42"]);
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

describe("durable home: one list with no filter", () => {
  it("conversation list: draws no filter chips", async () => {
    declares({ paneGrid: false, programHistory: true });
    serves(ROWS);
    renderHome(homeData());
    await screen.findByText("Invoice address change");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("conversation list: a program with no conversation yet says so in words", async () => {
    declares({ paneGrid: false });
    renderHome(homeData({ agents: [] }));
    await waitFor(() => expect(list()).not.toBeNull());
    expect(screen.getByText("This durable agent has no conversations yet.")).toBeInTheDocument();
  });

  it("durable home: a solo machine with no screen draws no footer tabs, a Herdr machine keeps Dashboard and Files", async () => {
    declares({ paneGrid: false });
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Dashboard views" })).toBeNull();
    cleanup();
    __resetOperatorCommands();
    declares({ paneGrid: true });
    renderHome(homeData({ agents: fixtureAgents, shellPanes: fixtureShellPanes, workspaces: fixtureWorkspaces, tabs: fixtureTabs }));
    await waitFor(() => expect(getMuxConfig()).not.toBeNull());
    expect(await screen.findByRole("button", { name: "Files" })).toBeInTheDocument();
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

describe("durable home: a program refused for its wire version says why (M55 spec 14)", () => {
  const SENTENCE = "The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK.";

  it("durable home: the sentence sits above the list in a caution box, and the list foot says it too", async () => {
    declares({ paneGrid: false, programHistory: true });
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: false, reason: "unreachable" })));
    noteSessionCards(
      [{ name: "default", isPrimary: true, reachable: false, agents: 0, working: 0, blocked: 0, kind: "program", state: "unreachable", notice: SENTENCE }],
      undefined,
    );
    renderHome(homeData({ agents: [] }));
    await waitFor(() => expect(list()).not.toBeNull());
    // Once in the box above the list, once in the list's foot in place of "did not answer".
    await waitFor(() => expect(screen.getAllByText(SENTENCE)).toHaveLength(2));
    const box = document.querySelector<HTMLElement>('[data-slot="notice"]');
    expect(box).toHaveTextContent(SENTENCE);
    expect(box?.querySelector('[role="status"]') ?? (box?.getAttribute("role") === "status" ? box : null)).not.toBeNull();
    // The box sits above the list, not inside it.
    expect(list()?.contains(box)).toBe(false);
    expect(screen.queryByText("The durable agent did not answer. Try again in a moment.")).toBeNull();
  });

  it("durable home: a program that is not refused draws no box", async () => {
    declares({ paneGrid: false });
    noteSessionCards([{ name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1, kind: "program", state: "ready" }], undefined);
    renderHome(homeData());
    await waitFor(() => expect(list()).not.toBeNull());
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(document.querySelector('[data-slot="notice"]')).toBeNull();
  });
});
