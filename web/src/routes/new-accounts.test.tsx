import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { useRootData } from "@/lib/route-data";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { asJsonObject, type JsonValue } from "@/lib/json";
import { clearStatus } from "@/lib/status";
import type { AgentView, HarnessInfo, MuxConfig, ServerSummary, WorktreePlanResponse } from "@/lib/types";
import { fixtureAgents } from "@/test/handlers";
import { body, defaultRow, HARNESS_CLAUDE, HARNESS_CODEX, serveAccounts, serveAccountsStatus, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewRoute } from "./new";

// THE ACCOUNT PICK ON THE NEW PAGE (M101): shown only for a built-in agent that has an ADDED account on the
// chosen machine; with none, or with the accounts route answering 404, the page and its request body are
// what they were before accounts existed.

function homeData(servers: ServerSummary[] = [], agents: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers,
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function Crew() {
  const data = useRootData();
  return (
    <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
      <Outlet />
    </CrewProvider>
  );
}

function mount(servers: ServerSummary[] = [], entry = "/new", agents: AgentView[] = []) {
  const data = homeData(servers, agents);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...data }),
        element: withHeaderHost(<Crew />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewRoute /> },
          { path: "pane/:paneId", element: <div data-testid="pane" /> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const HARNESSES: readonly HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: true },
];

function serveLaunchers(): void {
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({ launchers: [{ command: "htop", label: "htop" }], home: "/home/op", harnesses: HARNESSES }),
    ),
  );
}

function serveLaunch(bodies: JsonValue[]): void {
  server.use(
    http.post("/api/launch", async ({ request }) => {
      bodies.push((await request.json()) ?? null);
      return HttpResponse.json({
        ok: true,
        pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" },
      });
    }),
  );
}

const WORK_AND_DEFAULT = body({
  harnesses: [HARNESS_CLAUDE, HARNESS_CODEX],
  accounts: [
    defaultRow({ windows: [{ window: "5h", usedPct: 42, resetsAt: null }] }),
    workRow({ windows: [{ window: "7d", usedPct: 91, resetsAt: null }, { window: "5h", usedPct: 10, resetsAt: null }], seenAt: Date.now() - 5 * 60_000 }),
    defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" }),
  ],
});

const agentSelect = () => screen.findByRole("combobox", { name: "Agent" });
const accountSelect = () => screen.findByRole("combobox", { name: "Profile" });
/** The sorted keys of a request body, to pin that no `account` key rides a plain start. */
const keysOf = (value: JsonValue | undefined): string[] => Object.keys(asJsonObject(value) ?? {}).toSorted();
const summary = () => screen.getByTestId("new-page-summary");

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
});

/** The Again row, once the launcher read made it tappable: the row is drawn from the device's own record before that. */
async function againRow(name: RegExp): Promise<HTMLElement> {
  const row = await screen.findByRole("button", { name });
  await waitFor(() => expect(row).toBeEnabled());
  return row;
}

describe("the New page: the account pick", () => {
  it("with the accounts route answering 404 the page has no pick and the body is as before", async () => {
    serveLaunchers();
    serveAccountsStatus(404);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ harness: "claude", requestId: expect.any(String) });
    expect(keysOf(bodies[0])).toEqual(["harness", "requestId"]);
  });

  it("with no added account (only Default) the page has no pick", async () => {
    serveLaunchers();
    serveAccounts(body());
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull();
    expect(summary()).toHaveTextContent("Claude Code in");
  });

  it("an added account for the chosen agent shows a select, Default first, with the lead window under it", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    mount();
    const pick = await accountSelect();
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default", "Work"]);
    expect(pick).toHaveValue("claude:default");
    const caption = document.querySelector<HTMLElement>("[data-slot=account-caption]")!;
    expect(within(caption).getByText("5 hours")).toBeInTheDocument();
    expect(within(caption).getByText("42% used")).toBeInTheDocument();
    await userEvent.selectOptions(pick, "Work");
    const after = document.querySelector<HTMLElement>("[data-slot=account-caption]")!;
    // The lead window is the first one the harness lists.
    expect(within(after).getByText("Week")).toBeInTheDocument();
    expect(within(after).getByText("91% used")).toHaveClass("text-status-blocked");
    expect(within(after).queryByText("5 hours")).toBeNull();
    expect(within(after).getByText(/^Last seen /)).toBeInTheDocument();
    expect(summary()).toHaveTextContent("Claude Code as Work in");
  });

  it("starting with an added account sends it; Default sends none", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    mount();
    await userEvent.selectOptions(await accountSelect(), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ harness: "claude", account: "acc-work", requestId: expect.any(String) });
  });

  it("Default chosen sends the body of a start without accounts", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    mount();
    await accountSelect();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(keysOf(bodies[0])).toEqual(["harness", "requestId"]);
  });

  it("another agent without an added account hides the pick, and the pick does not leak across", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    mount();
    await userEvent.selectOptions(await accountSelect(), "Work");
    await userEvent.selectOptions(await agentSelect(), "Codex");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ harness: "codex", requestId: expect.any(String) });
  });

  it("the Shell half carries no pick", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    mount();
    await accountSelect();
    await userEvent.click(screen.getByRole("radio", { name: "Shell" }));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull());
  });

  it("a hand-written agent row carries no pick, and neither does its start body", async () => {
    const line = "CLAUDE_CONFIG_DIR=~/.claude-old claude";
    server.use(
      http.get("/api/launchers", () =>
        HttpResponse.json({
          launchers: [{ command: line, label: "Claude, my folder", harness: "claude" }],
          home: "/home/op",
          harnesses: HARNESSES,
          items: [
            { key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude", source: "builtin", noPrompts: false, branch: true, available: true },
            { key: `row:${line}`, start: { command: line }, group: "agents", label: "Claude, my folder", harness: "claude", command: line, source: "operator", noPrompts: false, branch: true, available: true },
          ],
          adding: { adds: false, freeText: false, run: false },
        }),
      ),
    );
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    mount();
    await accountSelect();
    await userEvent.selectOptions(await agentSelect(), "Claude, my folder");
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Profile" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ command: line, requestId: expect.any(String) });
  });

  it("Again repeats the account while the machine still lists it", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    const router = mount([], "/");
    await router.navigate("/new", { state: { from: "/" } });
    await userEvent.selectOptions(await accountSelect(), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    await router.navigate("/new", { state: { from: "/" } });
    await userEvent.click(await againRow(/Again/));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ harness: "claude", account: "acc-work" });
  });

  it("Again drops an account the machine no longer lists", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const bodies: JsonValue[] = [];
    serveLaunch(bodies);
    const router = mount([], "/");
    await router.navigate("/new", { state: { from: "/" } });
    await userEvent.selectOptions(await accountSelect(), "Work");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    cleanup();
    serveAccounts(body({ harnesses: [HARNESS_CLAUDE] }));
    const again = mount([], "/");
    await again.navigate("/new", { state: { from: "/" } });
    await userEvent.click(await againRow(/Again/));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(keysOf(bodies[1])).toEqual(["harness", "requestId"]);
  });

  it("a start on a new branch carries the account in the worktree body", async () => {
    serveLaunchers();
    serveAccounts(WORK_AND_DEFAULT);
    const mux: MuxConfig = { name: "reference", capabilities: { createWorktree: true }, unsupportedKeys: [], notes: {} };
    const plan: WorktreePlanResponse = {
      ok: true,
      repoRoot: "/home/op/src/app",
      defaultBranch: "main",
      currentBranch: "fix-old",
      branchValid: true,
      defaultTarget: { path: "/home/op/.herdr/worktrees/app/fix-tabs", exists: false },
    };
    const bodies: JsonValue[] = [];
    server.use(
      http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })),
      http.get("/api/worktree/plan", () => HttpResponse.json(plan)),
      http.post("/api/worktree", async ({ request }) => {
        bodies.push((await request.json()) ?? null);
        return HttpResponse.json({
          ok: true,
          alreadyOpen: false,
          launcherStarted: true,
          pane: { paneId: "w7:p1", workspaceId: "w7", workspaceLabel: "app", tabId: "w7:t1", cwd: "/home/op/.herdr/worktrees/app/fix-tabs" },
        });
      }),
    );
    const pane: AgentView = { ...fixtureAgents[0]!, paneId: "w1:p1", cwd: "/home/op/src/app", gitHead: { kind: "branch", name: "fix-old" } };
    const router = mount([], `/new?pane=${encodeURIComponent("w1:p1")}`, [pane]);
    await userEvent.selectOptions(await accountSelect(), "Work");
    const name = await screen.findByRole("textbox", { name: "Branch name" });
    await userEvent.clear(name);
    await userEvent.type(name, "fix-tabs");
    await waitFor(() => expect(screen.getByTestId("new-page-target")).toHaveTextContent("fix-tabs"));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w7%3Ap1"));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ harness: "claude", account: "acc-work", branch: "fix-tabs" });
  });
});
