import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { HomeRoute } from "./home";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { AgentView, FirstmateStatus, SessionSummary } from "@/lib/types";

const sessions: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
  { name: "collie-demo", isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0 },
];

function agent(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "working",
    cwd: "/home/you/webapp",
    focused: false,
    ...over,
  };
}

function homeData(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    firstmate: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions,
    session: undefined,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...over,
  };
}

function readyFirstmate(state: "ready" | "stale" = "ready"): FirstmateStatus {
  return {
    state,
    generatedAt: new Date().toISOString(),
    decisions: [
      {
        id: "d1",
        summary: "Approve the release cut",
        owner: "damian",
        endpoint: { session: "collie-demo", paneId: "w2:p9" },
      },
    ],
    inFlight: [],
    gates: [],
    landed: [],
    prs: [],
    prState: "disabled",
  };
}

function makeRouter(data: HomeData) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { index: true, element: <HomeRoute /> },
          {
            path: "pane/:paneId",
            element: <div data-testid="pane-route" />,
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
}

function renderHome(data: HomeData) {
  const router = makeRouter(data);
  render(<RouterProvider router={router} />);
  return router;
}

describe("HomeRoute — Firstmate composition", () => {
  it("renders nothing from Firstmate when it is absent, but still renders the herd", async () => {
    renderHome(homeData({ agents: [agent("w1:p1")] }));
    expect(screen.queryByText(/firstmate/i)).not.toBeInTheDocument();
    expect(await screen.findByText("webapp")).toBeInTheDocument();
  });

  it("shows Firstmate loading without hiding the agent list", async () => {
    renderHome(homeData({ agents: [agent("w1:p1")], firstmate: { state: "loading" } }));
    expect(await screen.findByText(/loading firstmate/i)).toBeInTheDocument();
    expect(screen.getByText("webapp")).toBeInTheDocument();
  });

  it("shows Firstmate unavailable without hiding the agent list", async () => {
    renderHome(
      homeData({
        agents: [agent("w1:p1")],
        firstmate: { state: "unavailable", reason: "timeout" },
      }),
    );
    expect(await screen.findByText(/didn.t respond in time/i)).toBeInTheDocument();
    expect(screen.getByText("webapp")).toBeInTheDocument();
  });

  it("shows Firstmate's valid-empty state without hiding the agent list", async () => {
    renderHome(
      homeData({
        agents: [agent("w1:p1")],
        firstmate: {
          state: "ready",
          generatedAt: new Date().toISOString(),
          decisions: [],
          inFlight: [],
          gates: [],
          landed: [],
          prs: [],
          prState: "disabled",
        },
      }),
    );
    expect(await screen.findByText("Nothing to report")).toBeInTheDocument();
    expect(screen.getByText("webapp")).toBeInTheDocument();
  });

  it("renders Firstmate above AgentList, never replacing it", async () => {
    renderHome(homeData({ agents: [agent("w1:p1")], firstmate: readyFirstmate() }));
    const decisionText = await screen.findByText(/approve the release cut/i);
    const agentRow = await screen.findByText("webapp");
    // DOCUMENT_POSITION_FOLLOWING on agentRow (relative to decisionText) means Firstmate comes first.
    expect(
      decisionText.compareDocumentPosition(agentRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("makes a stale feed visibly stale", async () => {
    renderHome(homeData({ firstmate: readyFirstmate("stale") }));
    expect(await screen.findByRole("status")).toHaveTextContent(/stale/i);
  });

  it("navigates a Firstmate task's endpoint via panePath(paneId, session)", async () => {
    const user = userEvent.setup();
    const router = makeRouter(homeData({ firstmate: readyFirstmate() }));
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByText(/approve the release cut/i));

    expect(await screen.findByTestId("pane-route")).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      panePath("w2:p9", "collie-demo"),
    );
  });
});
