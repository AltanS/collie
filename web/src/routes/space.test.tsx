import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { fixtureServers } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { SpaceRoute } from "./space";

// The space screen on a crew. The one thing asserted here is the HOST the space is read on: a lead's
// merged snapshot unions the peers' spaces and tags each pane with the machine it is on, and pane
// grouping is keyed on `(host, workspaceId)`. The route trusts the ADDRESSED host (`data.scope.host`,
// or the lead absent one) rather than re-deriving one from the found workspace — reading a peer's
// space while still keyed on the lead matched nothing, so every tab drew as "(empty tab)" while the
// header still counted the panes (#209).

const LEAD = "bluefin";
const PEER = "workshop";

const workspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "webapp",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    host: LEAD,
  },
  {
    workspaceId: "wA",
    number: 1,
    label: "Hermes",
    focused: false,
    activeTabId: "wA:t1",
    tabCount: 1,
    paneCount: 1,
    host: PEER,
  },
];

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "code", focused: false, paneCount: 1, host: LEAD },
  { tabId: "wA:t1", workspaceId: "wA", number: 1, label: "1", focused: false, paneCount: 1, host: PEER },
];

const peerAgent: AgentView = {
  paneId: "wA:p2",
  workspaceId: "wA",
  workspaceLabel: "Hermes",
  workspaceNumber: 1,
  tabId: "wA:t1",
  agent: "codex",
  paneLabel: "peer pane",
  status: "working",
  cwd: "/home/you/hermes",
  focused: false,
  host: PEER,
};

// `data.scope.host` is what the route trusts (`ambientHost`, lib/hosts.ts) — the loader's own
// `ambientSpaces` has already narrowed `workspaces`/`tabs` to that same addressed host before this
// route ever sees them, so a call here always addresses the host it navigates to, exactly as the
// loader would hand it off.
function dataFor(host: string | undefined): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [peerAgent],
    shellPanes: [],
    workspaces,
    tabs,
    sessions: [],
    servers: fixtureServers,
    ts: 0,
    scope: { host },
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function renderSpace(spaceId: string, host?: string) {
  const data = dataFor(host);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          {
            path: "space/:spaceId",
            element: withHeaderHost(
              <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
                <SpaceRoute />
              </CrewProvider>,
            ),
          },
        ],
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: [host ? `/space/${spaceId}?h=${host}` : `/space/${spaceId}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SpaceRoute on a crew", () => {
  it("lists a peer space's own panes instead of drawing every tab empty", async () => {
    renderSpace("wA", PEER);

    // Twice: the pane's own row, and the belt cell of its one-pane tab, which names the pane too.
    // The cell's `aria-hidden` semibold copy (it only reserves the label's width) is not a third.
    const shown = (await screen.findAllByText("peer pane")).filter(
      (el) => !el.closest('[aria-hidden="true"]'),
    );
    expect(shown).toHaveLength(2);
    expect(screen.queryByText("(empty tab)")).not.toBeInTheDocument();
  });

  it("still reads the lead's own space on the lead", async () => {
    renderSpace("w1");

    // Nothing of the peer's leaks in, and the lead's empty space says so rather than borrowing panes.
    expect(await screen.findByText("(empty tab)")).toBeInTheDocument();
    expect(screen.queryByText("peer pane")).not.toBeInTheDocument();
  });
});
