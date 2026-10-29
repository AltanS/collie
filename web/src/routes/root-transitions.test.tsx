import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { RootLayout } from "./root";
import { PANE_ROUTE_ID, ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { setStatus } from "@/lib/status";
import { fixtureAgents } from "@/test/handlers";
import type { AgentStatus, AgentView } from "@/lib/types";

vi.mock("@/lib/status", async (original) => ({
  ...(await original<typeof import("@/lib/status")>()),
  setStatus: vi.fn(),
}));

// RootLayout hands useAgentTransitions the open pane as a ROW key. It resolves the route's paneId
// through `findPane` with the pane route's own scope (`pane?.scope ?? data.scope`), so on a crew
// where two machines both hold `w6:p1` only the one on screen goes quiet.
const agent = (host: string, label: string, status: AgentStatus): AgentView => ({
  ...fixtureAgents[0]!,
  host,
  paneId: "w6:p1",
  workspaceLabel: label,
  status,
});

function home(agents: AgentView[]): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes: [],
    workspaces: [],
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
  };
}

function paneData(paneId: string, scope: PaneData["scope"]): PaneData {
  return {
    paneId,
    scope,
    text: "",
    truncated: false,
    requestedLines: 600,
    revision: 0,
    error: false,
    authError: false,
  };
}

/** Mount the layout on `entry`, then swap the herd for `after` and revalidate once. */
async function pollInto(
  entry: string,
  paneScope: PaneData["scope"],
  before: AgentView[],
  after: AgentView[],
) {
  let herd = before;
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => home(herd),
        element: <RootLayout />,
        children: [
          {
            id: PANE_ROUTE_ID,
            path: "pane/:paneId",
            loader: ({ params }) => paneData(params.paneId!, paneScope),
            element: <div>pane</div>,
          },
          { index: true, element: <div>dashboard</div> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.initialized).toBe(true));
  herd = after;
  await router.revalidate();
  await waitFor(() => expect(router.state.revalidation).toBe("idle"));
}

describe("RootLayout, the done line and the open pane", () => {
  beforeEach(() => vi.clearAllMocks());

  it("silences the open pane's row and announces the same-id pane on the other machine", async () => {
    await pollInto(
      "/pane/w6:p1",
      { host: "member-b" },
      [agent("member-a", "build", "working"), agent("member-b", "docs", "working")],
      [agent("member-a", "build", "done"), agent("member-b", "docs", "done")],
    );
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(setStatus).toHaveBeenCalledWith("claude is done · build", "success");
  });

  it("announces both when the open pane is a shell pane that is no agent row", async () => {
    await pollInto(
      "/pane/w9:p9",
      { host: "member-b" },
      [agent("member-a", "build", "working"), agent("member-b", "docs", "working")],
      [agent("member-a", "build", "done"), agent("member-b", "docs", "done")],
    );
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(2));
  });

  it("announces both on the dashboard, where no pane is open", async () => {
    await pollInto(
      "/",
      {},
      [agent("member-a", "build", "working"), agent("member-b", "docs", "working")],
      [agent("member-a", "build", "done"), agent("member-b", "docs", "done")],
    );
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(2));
  });
});
