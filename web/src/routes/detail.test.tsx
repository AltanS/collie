import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { AgentView } from "@/lib/types";
import { DetailRoute } from "./detail";

// Stub the heavy terminal view: this test is about DetailRoute's routing/freshPane logic, not the
// composer. The stub reports which pane it was handed and whether an agent resolved for it.
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, agent }: { paneId: string; agent?: AgentView }) => (
    <div data-testid="chat">{`pane:${paneId}:${agent ? "live" : "gone"}`}</div>
  ),
}));

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
  snoozedUntil: null,
  error: false,
});

function makeRouter(initialPath: string, homeLoader: () => HomeData) {
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
              text: "",
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
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
