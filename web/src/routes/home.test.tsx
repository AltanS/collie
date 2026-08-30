import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { PackProvider } from "@/components/pack-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import {
  fixtureAgents,
  fixturePackAgents,
  fixturePackSessions,
  fixturePackShellPanes,
  fixtureServers,
  fixtureSessions,
  fixtureShellPanes,
  fixtureTabs,
  fixtureWorkspaces,
} from "@/test/handlers";
import type { SnapshotResponse } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { HomeRoute } from "./home";

// The dashboard, one machine and several. The point of the pair is that the FIRST one is unchanged:
// a solo install renders no switcher, no chips and no extra affordance, and the multi-host case is
// the same screen with labels — never a per-host split, never a second list.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

const homeData = (snap: Partial<SnapshotResponse>, scope: HomeData["scope"] = {}): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents: snap.agents ?? [],
  shellPanes: snap.shellPanes ?? [],
  workspaces: snap.workspaces ?? fixtureWorkspaces,
  tabs: snap.tabs ?? fixtureTabs,
  sessions: snap.sessions ?? [],
  servers: snap.servers ?? [],
  ts: snap.ts ?? 0,
  scope,
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function renderHome(data: HomeData) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <PackProvider servers={data.servers} ts={data.ts} pollMs={1500}>
            <HomeRoute />
          </PackProvider>,
        ),
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
      { path: "/pack", element: <div data-testid="pack" /> },
    ],
    { initialEntries: [data.scope.host ? `/?h=${data.scope.host}` : "/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Wait for the herd list to be on screen. "needs you" alone is ambiguous — it is also the blocked
 *  status label on every row — so key off the section HEADING. */
const settled = () =>
  waitFor(() =>
    expect(
      screen.getAllByRole("heading").some((h) => /needs you/i.test(h.textContent ?? "")),
    ).toBe(true),
  );

const url = (router: ReturnType<typeof renderHome>) =>
  router.state.location.pathname + router.state.location.search;

const solo = () =>
  homeData({
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    sessions: fixtureSessions,
  });

const packed = () =>
  homeData({
    agents: fixturePackAgents,
    shellPanes: fixturePackShellPanes,
    sessions: fixturePackSessions,
    servers: fixtureServers,
  });

describe("the dashboard on ONE machine is untouched", () => {
  it("renders no host switcher and no host chip anywhere", async () => {
    renderHome(solo());
    await settled();
    expect(screen.queryByRole("button", { name: /switch host/i })).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText(/host:/i)).toHaveLength(0);
  });

  it("opens a pane at today's bare URL — no `?h=` is ever produced", async () => {
    const router = renderHome(solo());
    const rows = await screen.findAllByRole("button", { name: /webapp/i });
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(url(router)).toBe("/pane/w1%3Ap1"));
  });
});

describe("the dashboard across machines", () => {
  it("grows a host switcher beside the session switcher, and keeps ONE herd list", async () => {
    renderHome(packed());
    expect(await screen.findByRole("button", { name: /switch host/i })).toBeInTheDocument();
    // Sessions are per-host: the switcher offers this host's, not a flat merge of both "default"s.
    // Three buttons now, not two — "All sessions" leads the list. It is not a session and does not
    // pretend to be one: it answers "do I have to choose at all", which is why it stands above the
    // rows rather than among them.
    const sessionTrigger = screen.getByRole("button", { name: /switch session/i });
    await userEvent.click(sessionTrigger);
    const sheet = screen.getByRole("list");
    const rows = within(sheet).getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("All sessions");
  });

  it("labels each row with its machine — a label, never a split", async () => {
    renderHome(packed());
    await settled();
    expect(screen.getAllByLabelText("Host: bluefin").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Host: workshop").length).toBeGreaterThan(0);
    // No per-host heading anywhere: hosts do not carve the list up.
    const headings = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
    expect(headings.some((h) => /workshop|bluefin/i.test(h))).toBe(false);
  });

  it("opens a PEER's row addressed to the peer, not to the machine the URL points at", async () => {
    // The unforgivable failure this milestone exists to prevent: `w1:p1` exists on both machines, and
    // the merged list shows both. Tapping the peer's must not open the lead's identically-named pane.
    const router = renderHome(packed());
    await settled();
    const peerRow = screen.getAllByRole("button", { name: /moonward/i })[0]!;
    await userEvent.click(peerRow);
    await waitFor(() => expect(url(router)).toBe("/pane/w1%3Ap1?h=workshop"));
  });

  it("opens the LEAD's row with no host param — absent still means the lead", async () => {
    const router = renderHome(packed());
    await settled();
    const leadRow = screen.getAllByRole("button", { name: /webapp/i })[0]!;
    await userEvent.click(leadRow);
    await waitFor(() => expect(url(router)).toBe("/pane/w1%3Ap1"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 on the dashboard (M5/03). The milestone's counsel constraint: the agent you opened the app
// to unblock is exactly the one on the machine that just went quiet. It stays where it is.
// ─────────────────────────────────────────────────────────────────────────────

/** The same pack, with the machine holding the blocked peer agent gone quiet. */
const packedWithQuietPeer = () =>
  homeData({
    agents: fixturePackAgents,
    shellPanes: fixturePackShellPanes,
    sessions: fixturePackSessions,
    servers: fixtureServers.map((s) => {
      if (s.id !== "workshop") return s;
      // Mutate a clone rather than spread in the map body — one copy, and the two fields being
      // changed are the whole point of the fixture.
      const quiet = structuredClone(s);
      quiet.reachable = false;
      quiet.lastSeenAt = 1_000;
      return quiet;
    }),
    ts: 60_000, // the lead's clock, well past the 3 × 1500ms tolerance
  });

describe("a machine going quiet does not hide what is on it", () => {
  it("keeps the unreachable host's blocked agent in NEEDS YOU, labelled — never dropped or demoted", async () => {
    renderHome(packedWithQuietPeer());
    await settled();
    // `triage()` sorts on status and age and knows nothing about hosts — verified here as behaviour
    // rather than rebuilt: the peer's blocked row is present, and still carries its host label.
    expect(screen.getAllByRole("button", { name: /moonward/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/Host: workshop \(unreachable\)/i).length).toBeGreaterThan(0);
  });

  it("raises no app-wide connection chrome — the lead answered, so the phone is not offline", async () => {
    renderHome(packedWithQuietPeer());
    await settled();
    // Tier 1's copy, none of which belongs to a peer outage.
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard footer's pack line — the third way into /pack. Same hide rule as every other piece
// of host chrome, and the solo half of the pair is the one that matters: the footer must look
// exactly as it did before the pack existed.
// ─────────────────────────────────────────────────────────────────────────────

describe("the pack line in the dashboard footer", () => {
  it("is absent on a solo install — the footer keeps its shipped shape", async () => {
    renderHome(solo());
    await settled();
    expect(screen.queryByLabelText(/open the pack overview/i)).not.toBeInTheDocument();
  });

  it("names the roster from the snapshot alone — no second fetch to caption a footer", async () => {
    renderHome(packed());
    const link = await screen.findByLabelText(/open the pack overview/i);
    expect(link).toHaveTextContent(/3 machines/i);
    expect(link).toHaveTextContent(/2 reachable/i);
  });

  it("navigates to the census, carrying the scope's host so back lands where you were", async () => {
    const router = renderHome(homeData({ agents: fixturePackAgents, servers: fixtureServers }, { host: "workshop" }));
    await userEvent.click(await screen.findByLabelText(/open the pack overview/i));
    await waitFor(() => expect(url(router)).toBe("/pack?h=workshop"));
  });

  it("omits `?h=` when the scope is the lead — a bare path, exactly like every other helper", async () => {
    const router = renderHome(packed());
    await userEvent.click(await screen.findByLabelText(/open the pack overview/i));
    await waitFor(() => expect(url(router)).toBe("/pack"));
  });
});
