import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { readAgentLaunch, type AgentLaunch } from "@/lib/agent-startup";
import { paneScopeKey } from "@/lib/scope";
import { panePath } from "@/lib/nav";
import { __resetOperatorCommands, getMuxConfig } from "@/lib/operator-config";
import { server } from "@/test/setup";
import type { AgentView } from "@/lib/types";
import { DetailRoute } from "./detail";

// Stub the heavy terminal view: this test is about DetailRoute's routing/freshPane logic, not the
// composer. The stub reports which pane it was handed and whether an agent resolved for it.
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, agent, onBackArrow, agentLaunch, onLaunchReady }: { paneId: string; agent?: AgentView; onBackArrow?: () => void; agentLaunch?: AgentLaunch; onLaunchReady?: () => void }) => (
    <>
      <div data-testid="chat">{`pane:${paneId}:${agent ? "live" : "gone"}`}</div>
      <span>{`launch:${agentLaunch?.harness ?? "none"}`}</span>
      <button onClick={onLaunchReady}>first screen ready</button>
      <button type="button" onClick={onBackArrow}>
        back
      </button>
    </>
  ),
}));

// The stall indicator has its own unit test; here it's noise (and would leave a pending timer), so
// pin it idle.
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

function agentView(paneId: string, kind: "agent" | "shell"): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: kind === "agent" ? "claude" : "shell",
    status: "unknown",
    cwd: "/home",
    focused: false,
    kind,
  };
}

const connected = (agents: AgentView[], shellPanes: AgentView[] = []): HomeData => ({
  bridge: "connected",
  agents,
  shellPanes,
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

function makeRouter(initialPath: string, homeLoader: () => HomeData, paneExtra: Partial<PaneData> = {}) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeLoader(),
        element: <Outlet />,
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          {
            path: "pane/:paneId",
            loader: ({ params }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: {},
              text: "",
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
              authError: false,
              ...paneExtra,
            }),
            element: <DetailRoute />,
          },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
}

describe("DetailRoute — freshPane bootstrap", () => {
  it("shows a freshly-created pane opened from the home screen", async () => {
    const router = makeRouter("/", () => connected([]));
    render(<RouterProvider router={router} />);
    await screen.findByTestId("home");

    const fresh = agentView("w1:p2", "shell"); // not in the snapshot yet
    await act(async () => {
      await router.navigate(panePath("w1:p2"), { state: { freshPane: fresh } });
    });

    expect(await screen.findByTestId("chat")).toHaveTextContent("pane:w1:p2:live");
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));
  });

  it("shows a tab created from inside an open pane instead of bouncing Home", async () => {
    // Regression: DetailRoute does not remount on a pane→pane navigation, so a component-lifetime
    // "seen" flag set while viewing pane A used to disable pane B's freshPane fallback — evicting B
    // before the snapshot caught up and firing the closed-pane redirect to "/".
    const paneA = agentView("w1:p1", "agent");
    const router = makeRouter(panePath("w1:p1"), () => connected([paneA]));
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("chat")).toHaveTextContent("pane:w1:p1:live");

    const fresh = agentView("w1:p2", "shell"); // freshly created, not in the snapshot yet
    await act(async () => {
      await router.navigate(panePath("w1:p2"), { state: { freshPane: fresh } });
    });

    expect(await screen.findByTestId("chat")).toHaveTextContent("pane:w1:p2:live");
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));
    expect(screen.queryByTestId("home")).not.toBeInTheDocument();
  });

  it("redirects Home when a seen pane disappears from a connected snapshot", async () => {
    // The flip side: once a pane has actually appeared in a snapshot, its freshPane is retired, so a
    // later snapshot that no longer lists it (you ran `exit`) must bounce Home rather than strand you.
    const paneA = agentView("w1:p1", "agent");
    let home = connected([paneA]);
    const router = makeRouter(panePath("w1:p1"), () => home);
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("chat")).toHaveTextContent("pane:w1:p1:live");

    // The pane closes: revalidate the root loader to an empty (still-connected) snapshot.
    home = connected([]);
    await act(async () => {
      await router.revalidate();
    });

    await screen.findByTestId("home");
    expect(router.state.location.pathname).toBe("/");
  });
});

// M46 spec 10: with the bridge away the herd on screen may not hold the pane (the root loader re-ran
// at the pane's own address and kept nothing there), and the pane loader then carries the pane's row
// from a herd the phone kept. Only a herd that is not a live answer may be outranked by it.
describe("DetailRoute — the pane's saved row", () => {
  const saved = agentView("w1:p1", "agent");

  it("names the pane from its saved row while the herd on screen is not a live answer", async () => {
    const away: HomeData = { ...connected([]), error: true, stale: true };
    const router = makeRouter(panePath("w1:p1"), () => away, { error: true, savedPane: saved });
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("chat")).toHaveTextContent("pane:w1:p1:live");
  });

  it("lets a live herd without the pane outrank the saved row: the pane closed", async () => {
    const router = makeRouter(panePath("w1:p1"), () => connected([]), { error: true, savedPane: saved });
    render(<RouterProvider router={router} />);
    await screen.findByTestId("home");
    expect(router.state.location.pathname).toBe("/");
  });
});

// M53 spec 12: on a machine with no screen the pane's way back is the conversation list, the machine's home,
// whatever page the pane was reached from.
describe("DetailRoute: the durable home is the way back", () => {
  // The one-shot config store outlives a test: start and end each case with it empty.
  beforeEach(() => __resetOperatorCommands());
  afterEach(() => __resetOperatorCommands());

  function declares(capabilities: Record<string, boolean>) {
    const mux = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
  }

  it("durable home: the back arrow of a pane with no screen lands on the list, not the space it came from", async () => {
    declares({ paneGrid: false });
    const pane = agentView("w1:p1", "agent");
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => connected([pane]),
          element: <Outlet />,
          children: [
            { index: true, element: <div data-testid="home">HOME</div> },
            { path: "space/:id", element: <div data-testid="space">SPACE</div> },
            {
              path: "pane/:paneId",
              loader: ({ params }): PaneData => ({
                paneId: params.paneId ?? "",
                scope: {},
                text: "",
                truncated: false,
                requestedLines: 600,
                revision: 0,
                error: false,
                authError: false,
              }),
              element: <DetailRoute />,
            },
          ],
        },
      ],
      // Opened from a space: the entry behind is the space, and the pane carries it as its `from`.
      { initialEntries: ["/space/w1", { pathname: panePath("w1:p1"), state: { from: "/space/w1" } }], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    await screen.findByTestId("chat");
    // The config lands after the first paint; the tap waits for the hook to have its answer.
    await waitFor(() => expect(getMuxConfig()).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
  });
});


describe("DetailRoute: a launch's intent", () => {
  it("rides beside the freshPane and is retired without losing it, its from or Back", async () => {
    const router = makeRouter("/", () => connected([]));
    render(<RouterProvider router={router} />);
    await screen.findByTestId("home");
    const fresh = agentView("w1:p2", "shell");
    const agentLaunch = { id: "intent", paneKey: paneScopeKey({}, fresh.paneId), harness: "kiro" };
    await act(() => router.navigate(panePath(fresh.paneId), { state: { freshPane: fresh, agentLaunch, from: "/" } }));
    expect(await screen.findByText("launch:kiro")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "first screen ready" }));
    await screen.findByText("launch:none");
    expect(readAgentLaunch(router.state.location.state, fresh.paneId)).toBeUndefined();
    expect(router.state.location.state?.freshPane).toEqual(fresh);
    expect(router.state.location.state?.from).toBe("/");
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await screen.findByTestId("home");
  });

  it("is refused for a same-numbered pane in another session", async () => {
    const fresh = agentView("w1:p2", "shell");
    const router = makeRouter("/", () => connected([]));
    render(<RouterProvider router={router} />);
    await screen.findByTestId("home");
    await act(() => router.navigate(panePath(fresh.paneId), { state: { freshPane: fresh,
      agentLaunch: { id: "foreign", paneKey: paneScopeKey({ session: "other" }, fresh.paneId), harness: "kiro" } } }));
    expect(await screen.findByText("launch:none")).toBeInTheDocument();
  });
});
