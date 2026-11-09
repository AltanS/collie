import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { fixtureServers } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import type { StartLaunchBody } from "@/lib/api";
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

// THE TAB ROW'S "+" OFFERS THE MACHINE'S AGENTS (M91 spec 02): on the space view the "+" opens the
// New tab sheet for the space on screen, read from that space's own machine, and a row starts as a tab
// beside the space's pane there.
describe("SpaceRoute, the tab row's '+'", () => {
  it("opens the New tab sheet of the addressed machine, and starts a row beside the space's pane", async () => {
    const reads: string[] = [];
    const launches: { host: string | null; body: StartLaunchBody }[] = [];
    server.use(
      http.get("/api/launchers", ({ request }) => {
        reads.push(new URL(request.url).searchParams.get("host") ?? "");
        return HttpResponse.json({
          launchers: [],
          home: "/home/you",
          harnesses: [],
          items: [
            { key: "harness:codex", start: { harness: "codex" }, group: "agents", label: "Codex", harness: "codex", source: "builtin", noPrompts: false, branch: true, available: true },
            { key: "shell", start: { shell: true }, group: "commands", label: "Shell", source: "builtin", noPrompts: false, branch: true, available: true },
          ],
        });
      }),
      http.post("/api/launch", async ({ request }) => {
        // SAFETY: the body is the app's own: `lib/api.ts`'s `startLaunch` is the only caller and it posts a `StartLaunchBody`.
        const body = (await request.json()) as StartLaunchBody;
        launches.push({ host: new URL(request.url).searchParams.get("host"), body });
        return HttpResponse.json({ ok: true, pane: { paneId: "wA:p5", workspaceId: "wA", workspaceLabel: "Hermes", tabId: "wA:t2", cwd: "/home/you/hermes" } });
      }),
    );
    const router = renderSpace("wA", PEER);
    await userEvent.click(await screen.findByRole("button", { name: "New tab" }));
    const sheet = within(await screen.findByRole("dialog", { name: "New tab in Hermes" }));
    expect(sheet.getByText("In ~/hermes")).toBeInTheDocument();
    await userEvent.click(await sheet.findByRole("button", { name: /Codex/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/wA%3Ap5"));
    expect(reads.every((h) => h === PEER)).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.host).toBe(PEER);
    expect(launches[0]!.body).toMatchObject({ harness: "codex", paneId: "wA:p2" });
  });
});
