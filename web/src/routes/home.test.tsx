import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { setPinned } from "@/lib/pins";
import {
  fixtureAgents,
  fixtureCrewAgents,
  fixtureCrewSessions,
  fixtureCrewShellPanes,
  fixtureCrewTabs,
  fixtureCrewWorkspaces,
  fixtureServers,
  fixtureSessions,
  fixtureShellPanes,
  fixtureTabs,
  fixtureWorkspaces,
} from "@/test/handlers";
import type { SnapshotResponse } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// The dashboard, one machine and several. The point of the pair is that the FIRST one is unchanged:
// a solo install renders no switcher, no chips and no extra affordance, and the multi-host case is
// the same screen with labels — never a per-host split, never a second list.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
// The Crew tab's body is another component's business (components/crew-tab.tsx); here it is a marker,
// so these tests check that the tab mounts it and only while selected.
vi.mock("@/components/crew-tab", () => ({ CrewTab: () => <div data-testid="crew-tab" /> }));

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

function renderHome(data: HomeData, initialPath?: string) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider
            servers={data.servers}
            sessions={data.sessions}
            ts={data.ts}
            pollMs={1500}
          >
            <HomeRoute />
          </CrewProvider>,
        ),
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
      { path: "/space/:spaceId/changes", element: <div data-testid="space-changes" /> },
      { path: "/crew", element: <div data-testid="crew" /> },
    ],
    { initialEntries: [initialPath ?? (data.scope.host ? `/?h=${data.scope.host}` : "/")] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Wait for the herd list to be on screen. The workspace select (components/agent-list.tsx) is the one
 *  control every render with at least one pane produces — there is no "Needs you" heading to wait
 *  on any more, since a pane no longer moves to a section of its own. */
const settled = () => screen.findByRole("combobox", { name: "Workspace" });

/** The `<section>` a workspace heading owns, scoped away from the workspace select's own options,
 *  which carry the same workspace name a heading does (agent-list.tsx). */
const groupSection = (label: string) => screen.getByRole("heading", { name: label }).closest("section")!;

/** A workspace group's pane rows: the buttons in its list, never the "+" at the end of its heading
 *  (M40/03), which is a button of the same section. */
const rowsOf = (section: HTMLElement) =>
  within(section.querySelector<HTMLElement>('[data-slot="list-group"]')!).getAllByRole("button");

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
    agents: fixtureCrewAgents,
    shellPanes: fixtureCrewShellPanes,
    sessions: fixtureCrewSessions,
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
    await settled();
    // The row's own text is just its name and its tab now — "webapp" only names the workspace
    // heading (and its Spaces chip), so the row is found through its group instead.
    const [row] = rowsOf(groupSection("webapp"));
    await userEvent.click(row!);
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
    const [peerRow] = rowsOf(groupSection("moonward"));
    await userEvent.click(peerRow!);
    await waitFor(() => expect(url(router)).toBe("/pane/w1%3Ap1?h=workshop"));
  });

  it("opens the LEAD's row with no host param — absent still means the lead", async () => {
    const router = renderHome(packed());
    await settled();
    const [leadRow] = rowsOf(groupSection("webapp"));
    await userEvent.click(leadRow!);
    await waitFor(() => expect(url(router)).toBe("/pane/w1%3Ap1"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The space navigator, addressed at a peer (#209). The loader's `ambientSpaces` narrows
// `workspaces`/`tabs` to the host `?h=` names before HomeRoute ever sees them — this fixture mirrors
// that narrowing by hand — so the row on screen is the addressed host's own "moonward", and the
// navigator must key it by that SAME host, not the lead's, to find its blocked agent.
// ─────────────────────────────────────────────────────────────────────────────

describe("the space navigator on a crew, addressed at a peer (#209)", () => {
  it("gives the peer's own space its recency and blocked dot on ?h=<peer>", async () => {
    const peerWorkspace = fixtureCrewWorkspaces.find((w) => w.host === "workshop")!;
    const peerTabs = fixtureCrewTabs.filter((t) => t.host === "workshop");
    renderHome(
      homeData(
        {
          agents: fixtureCrewAgents,
          shellPanes: fixtureCrewShellPanes,
          workspaces: [peerWorkspace],
          tabs: peerTabs,
          sessions: fixtureCrewSessions,
          servers: fixtureServers,
        },
        { host: "workshop" },
      ),
    );
    await settled();
    const spacesBody = document.getElementById("spaces-body");
    if (!spacesBody) throw new Error("the Spaces section did not render");
    const spaceRow = within(spacesBody).getByRole("button", { name: /moonward/i });
    // Keyed on the LEAD instead, this row's status lookup misses entirely and shows no dot at all —
    // the bug this test pins.
    expect(within(spaceRow).getByText(/needs you/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 on the dashboard (M5/03). The milestone's counsel constraint: the agent you opened the app
// to unblock is exactly the one on the machine that just went quiet. It stays where it is.
// ─────────────────────────────────────────────────────────────────────────────

/** The same crew, with the machine holding the blocked peer agent gone quiet. */
const packedWithQuietPeer = () =>
  homeData({
    agents: fixtureCrewAgents,
    shellPanes: fixtureCrewShellPanes,
    sessions: fixtureCrewSessions,
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
  it("keeps the unreachable host's blocked pane in its workspace group, labelled — never dropped or demoted", async () => {
    renderHome(packedWithQuietPeer());
    await settled();
    // The peer's blocked row is present in its own workspace group, still carries its host label,
    // and the group heading still lights up for it — never silently demoted.
    const section = groupSection("moonward");
    const rows = rowsOf(section);
    expect(rows.length).toBeGreaterThan(0);
    expect(within(rows[0]!).getByLabelText(/Host: workshop \(unreachable\)/i)).toBeInTheDocument();
    // The heading's own count, not the row's sr-only status word (which reads the same "needs you").
    expect(within(section).getByLabelText("1 needs you")).toBeInTheDocument();
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
// The dashboard footer's crew line — the third way into /crew. Same hide rule as every other piece
// of host chrome, and the solo half of the pair is the one that matters: the footer must look
// exactly as it did before the crew existed.
// ─────────────────────────────────────────────────────────────────────────────

describe("the crew line in the dashboard footer", () => {
  it("is absent on a solo install — the footer keeps its shipped shape", async () => {
    renderHome(solo());
    await settled();
    expect(screen.queryByLabelText(/open the crew overview/i)).not.toBeInTheDocument();
  });

  it("names the roster from the snapshot alone — no second fetch to caption a footer", async () => {
    renderHome(packed());
    const link = await screen.findByLabelText(/open the crew overview/i);
    expect(link).toHaveTextContent(/3 machines/i);
    expect(link).toHaveTextContent(/2 reachable/i);
  });

  it("navigates to the census, carrying the scope's host so back lands where you were", async () => {
    const router = renderHome(homeData({ agents: fixtureCrewAgents, servers: fixtureServers }, { host: "workshop" }));
    await userEvent.click(await screen.findByLabelText(/open the crew overview/i));
    await waitFor(() => expect(url(router)).toBe("/crew?h=workshop"));
  });

  it("omits `?h=` when the scope is the lead — a bare path, exactly like every other helper", async () => {
    const router = renderHome(packed());
    await userEvent.click(await screen.findByLabelText(/open the crew overview/i));
    await waitFor(() => expect(url(router)).toBe("/crew"));
  });
});

// ── THE WIDENED DASHBOARD ────────────────────────────────────────────────────
//
// One list across every Herdr session on this machine. The hazard it brings is the crew's hazard one
// dimension down: `w1:p1` is a different terminal in every session, and here BOTH of them are on
// screen at once, in the same section, under the same name.
describe("the dashboard across sessions", () => {
  const sessions = [
    { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 1 },
    { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 1 },
  ];
  const blocked = fixtureAgents[0]!; // w1:p1, blocked, in the "webapp" space
  const widened = () =>
    homeData({
      agents: [
        { ...blocked, session: "default" },
        { ...blocked, session: "work" },
      ],
      sessions,
    });
  /** The colliding rows. Two sessions, each numbering its own workspaces from 1, means TWO "webapp"
   *  groups now — one per (host, session, workspaceId) — rather than one shared section, so this
   *  gathers the rows out of both. Scoped away from the space navigator below, which also names
   *  `webapp`, because this test is about how many TERMINALS are listed, not how many spaces. */
  const rows = () => {
    const sections = screen.getAllByRole("heading", { name: "webapp" }).map((h) => h.closest("section")!);
    return sections.flatMap((s) => rowsOf(s));
  };

  it("renders BOTH colliding rows, not one recycled row", async () => {
    // A React key of `paneId` alone silently collapses these two — or worse, recycles one element
    // for the other between polls, so the card you are looking at acquires the other row's onClick.
    renderHome(widened(), "/?all=1");
    await settled();
    expect(rows().length).toBe(2);
  });

  it("marks the row that is NOT in the primary session, and only that one", async () => {
    renderHome(widened(), "/?all=1");
    await settled();
    expect(screen.getByLabelText("In session: work")).toBeInTheDocument();
    // The primary needs no mark: an absent `?s=` already means it.
    expect(screen.queryByLabelText("In session: default")).toBeNull();
  });

  it("opens each row in its OWN session", async () => {
    // THE GUARD, end to end. Both rows say `w1:p1`; the one from `work` must carry `?s=work`, and
    // the primary one must carry no session param at all — today's bare url.
    const router = renderHome(widened(), "/?all=1");
    await settled();
    await userEvent.click(rows()[1]!);
    expect(url(router)).toBe("/pane/w1%3Ap1?s=work");
  });

  it("opens the primary row at today's bare url", async () => {
    const router = renderHome(widened(), "/?all=1");
    await settled();
    await userEvent.click(rows()[0]!);
    expect(url(router)).toBe("/pane/w1%3Ap1");
  });

  it("keeps the space navigator on the ambient session", async () => {
    // The lists widen; the tree does not. Workspace ids collide across sessions too, and the tree
    // keys by `(host, workspaceId)` with no session in it — so an unfiltered widened body would
    // paint the `work` session's panes onto the ambient space of the same number and count them
    // twice. One row per workspace, never one per (workspace × session).
    renderHome(widened(), "/?all=1");
    await settled();
    expect(screen.getAllByLabelText(/1 pane/i).length).toBe(1);
  });
});

describe("the dashboard's footer (ADR 0066, ADR 0085)", () => {
  const footer = () => screen.getByRole("navigation", { name: "Dashboard views" });
  const tab = (name: RegExp) => within(footer()).getByRole("button", { name });
  const tabNames = () => within(footer()).getAllByRole("button").map((b) => b.textContent);
  const NEEDS = { name: "Show only panes that need you" };
  const needsSwitch = () => screen.getByRole("button", NEEDS);
  const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1")!);

  it("opens on Dashboard, with every workspace listed and the switch off", async () => {
    renderHome(solo());
    await settled();
    expect(tab(/^Dashboard/)).toHaveAttribute("aria-current", "page");
    expect(needsSwitch()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "collie" })).toBeInTheDocument();
  });

  it("a solo Collie has two tabs, Dashboard and Files, and no Crew", async () => {
    renderHome(solo());
    await settled();
    expect(tabNames()).toHaveLength(2);
    expect(tab(/^Dashboard/)).toBeInTheDocument();
    expect(tab(/^Files$/)).toBeInTheDocument();
    expect(within(footer()).queryByRole("button", { name: /^Crew/ })).not.toBeInTheDocument();
  });

  it("a crew has three: Crew, Dashboard, Files, in that order, and Dashboard stays the default", async () => {
    renderHome(packed());
    await settled();
    // The word is the tab's one truncated line; the mark and its screen-reader text sit beside it.
    expect(within(footer()).getAllByRole("button").map((b) => b.querySelector("span.truncate")?.textContent)).toEqual([
      "Crew",
      "Dashboard",
      "Files",
    ]);
    expect(tab(/^Dashboard/)).toHaveAttribute("aria-current", "page");
  });

  it("the Crew tab mounts its body only while it is selected", async () => {
    renderHome(packed());
    await settled();
    expect(screen.queryByTestId("crew-tab")).not.toBeInTheDocument();
    await userEvent.click(tab(/^Crew$/));
    expect(tab(/^Crew$/)).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("crew-tab")).toBeInTheDocument();
    expect(stored().dashView).toBe("crew");
    await userEvent.click(tab(/^Dashboard/));
    expect(screen.queryByTestId("crew-tab")).not.toBeInTheDocument();
  });

  it("the Crew tab draws none of the pane chrome: no space strip, no summary line, no Pinned group", async () => {
    const data = packed();
    setPinned(data.agents[0]!, true, data.agents);
    renderHome(data);
    await settled();
    // The Dashboard has all three, so the absence below is the tab's doing and not the fixture's.
    expect(screen.getByRole("combobox", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Pane order" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /need you/i })).toBeInTheDocument();

    await userEvent.click(tab(/^Crew$/));
    expect(screen.getByTestId("crew-tab")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Pane order" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /need you/i })).not.toBeInTheDocument();
    // The body is the first thing in the page's main: nothing sits above the machine cards.
    expect(screen.getByRole("main").firstElementChild?.firstElementChild).toBe(screen.getByTestId("crew-tab"));

    // Back on the Dashboard the chrome is as it was left.
    await userEvent.click(tab(/^Dashboard/));
    expect(screen.getByRole("combobox", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pinned" })).toBeInTheDocument();
  });

  it("the Crew tab still draws its body when the crew has no pane anywhere", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "crew" }));
    renderHome(homeData({ servers: fixtureServers, sessions: [] }));
    expect(await screen.findByTestId("crew-tab")).toBeInTheDocument();
  });

  it("a stored crew tab with no crew shows the Dashboard and leaves the stored value alone", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "crew" }));
    renderHome(solo());
    await settled();
    expect(tab(/^Dashboard/)).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(stored()).toEqual({ dashView: "crew" });
  });

  it("opens on the Dashboard with the switch on when a device's stored tab was Focus (ADR 0085)", async () => {
    // "focus" is the tab's name since ADR 0068; "needs" and "attention" are the names before it.
    for (const old of ["focus", "needs", "attention"]) {
      localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: old }));
      renderHome(solo());
      await settled();
      expect(tab(/^Dashboard/)).toHaveAttribute("aria-current", "page");
      expect(needsSwitch()).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("heading", { name: "collie" })).not.toBeInTheDocument();
      expect(stored()).toMatchObject({ dashView: "dashboard", needsYouOnly: true });
      cleanup();
    }
  });

  it("opens on the Dashboard when a device's stored tab was the old Panes", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "panes" }));
    renderHome(solo());
    await settled();
    expect(tab(/^Dashboard/)).toHaveAttribute("aria-current", "page");
    expect(needsSwitch()).toHaveAttribute("aria-pressed", "false");
  });

  it("marks the Dashboard tab with the count of blocked panes, and only that tab", async () => {
    renderHome(solo());
    await settled();
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard, 1 blocked");
    expect(tab(/^Dashboard/).querySelector('[data-slot="tab-badge"]')).toHaveTextContent("1");
    expect(tab(/^Files$/)).toHaveTextContent(/^Files$/);
  });

  // The red count means something waits on you. A finished pane you have not opened is news, not a
  // demand, so it gets the quiet dot and no number (ADR 0066).
  const withAgents = (agents: SnapshotResponse["agents"]) =>
    homeData({ agents, shellPanes: fixtureShellPanes, sessions: fixtureSessions });
  const unseen = { ...fixtureAgents[1]!, status: "done" as const, lastActiveAt: 2, lastSeenAt: 1 };
  const quiet = fixtureAgents.map((a) => ({ ...a, status: "working" as const }));

  it("counts only the blocked panes when finished-unseen ones are there too", async () => {
    renderHome(withAgents([fixtureAgents[0]!, unseen]));
    await settled();
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard, 1 blocked");
    expect(tab(/^Dashboard/).querySelector('[data-slot="tab-dot"]')).toBeNull();
  });

  it("shows the quiet dot and no number when only finished-unseen panes wait", async () => {
    renderHome(withAgents([quiet[0]!, unseen]));
    await settled();
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard, finished panes unseen");
    expect(tab(/^Dashboard/).querySelector('[data-slot="tab-dot"]')).not.toBeNull();
    expect(tab(/^Dashboard/).querySelector('[data-slot="tab-badge"]')).toBeNull();
  });

  it("marks nothing when no pane is blocked or unseen", async () => {
    renderHome(withAgents(quiet));
    await settled();
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard");
    expect(tab(/^Dashboard/).querySelector('[data-slot="tab-dot"], [data-slot="tab-badge"]')).toBeNull();
  });

  it("keeps the mark on the Dashboard tab with the switch on, and on Files", async () => {
    renderHome(solo());
    await settled();
    await userEvent.click(needsSwitch());
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard, 1 blocked");
    await userEvent.click(tab(/^Files$/));
    expect(tab(/^Dashboard/)).toHaveAccessibleName("Dashboard, 1 blocked");
  });

  it("the switch drops the quiet workspace, keeps the heading's full counts, and is remembered", async () => {
    renderHome(solo());
    await settled();
    await userEvent.click(needsSwitch());
    expect(needsSwitch()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "collie" })).not.toBeInTheDocument();
    // The select still offers every workspace: the filter removes rows, never places.
    const select = screen.getByRole("combobox", { name: "Workspace" });
    expect(within(select).getByRole("option", { name: /^collie/ })).toBeInTheDocument();
    expect(stored().needsYouOnly).toBe(true);
    // A new mount reads it back.
    cleanup();
    renderHome(solo());
    await settled();
    expect(needsSwitch()).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "collie" })).not.toBeInTheDocument();
    // And off again brings the workspace back.
    await userEvent.click(needsSwitch());
    expect(screen.getByRole("heading", { name: "collie" })).toBeInTheDocument();
    expect(stored().needsYouOnly).toBe(false);
  });

  it("the switch with nothing urgent shows the all-clear line and no list", async () => {
    const calm = fixtureAgents.map((a) => Object.assign(structuredClone(a), { status: "working" as const }));
    renderHome(homeData({ agents: calm, shellPanes: fixtureShellPanes, sessions: fixtureSessions }));
    await settled();
    await userEvent.click(needsSwitch());
    expect(screen.getByText("Nothing needs you")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "webapp" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "collie" })).not.toBeInTheDocument();
  });

  it("the order select stays in the control row in both states", async () => {
    renderHome(solo());
    await settled();
    expect(screen.getByRole("combobox", { name: "Pane order" })).toBeInTheDocument();
    await userEvent.click(needsSwitch());
    expect(screen.getByRole("combobox", { name: "Pane order" })).toBeInTheDocument();
  });

  it("the workspace select shows one workspace alone, and the choice is remembered", async () => {
    renderHome(solo());
    const select = await settled();
    expect(select).toHaveValue("all");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All workspaces",
      expect.stringMatching(/^webapp/),
      expect.stringMatching(/^collie/),
    ]);
    await userEvent.selectOptions(select, within(select).getByRole("option", { name: /^collie/ }));
    expect(screen.queryByRole("heading", { name: "webapp" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "collie" })).toBeInTheDocument();
    expect(stored().isolatedSpace).toEqual(expect.stringContaining("collie"));
    // A new mount reads it back, and "All workspaces" clears it.
    cleanup();
    renderHome(solo());
    const again = await settled();
    expect(within(again).getByRole("option", { name: /^collie/ })).toHaveProperty("selected", true);
    expect(screen.queryByRole("heading", { name: "webapp" })).not.toBeInTheDocument();
    await userEvent.selectOptions(again, "all");
    expect(screen.getByRole("heading", { name: "webapp" })).toBeInTheDocument();
    expect(stored().isolatedSpace).toBeNull();
  });

  it("the order select changes the list to one ranked list, and the choice is remembered", async () => {
    renderHome(solo());
    await settled();
    const order = screen.getByRole("combobox", { name: "Pane order" });
    expect(within(order).getAllByRole("option").map((o) => o.textContent)).toEqual(["Place", "Activity", "Cache"]);
    expect(order).toHaveValue("place");
    await userEvent.selectOptions(order, "activity");
    expect(screen.getByRole("heading", { name: /^Newest first/ })).toBeInTheDocument();
    expect(stored().paneOrder).toBe("activity");
    cleanup();
    renderHome(solo());
    await settled();
    expect(screen.getByRole("combobox", { name: "Pane order" })).toHaveValue("activity");
  });

  it("the summary words and the switch share one row, above the two selects", async () => {
    renderHome(solo());
    const workspace = await settled();
    const summary = screen.getByRole("button", { name: /need you/i });
    const order = screen.getByRole("combobox", { name: "Pane order" });
    // One row holds the line and the switch; one row holds both selects, workspace first.
    expect(summary.parentElement).toContainElement(needsSwitch());
    const selectRow = workspace.closest('[data-slot="select"]')!.parentElement!;
    expect(selectRow).toContainElement(order);
    expect(selectRow).not.toContainElement(summary);
    expect(summary.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the launch strip, the Spaces navigator and the pin hint show only while the switch is off", async () => {
    renderHome(solo());
    await settled();
    expect(screen.getByRole("heading", { name: /^Spaces/ })).toBeInTheDocument();
    expect(screen.getByText(/pin it here/)).toBeInTheDocument();
    await userEvent.click(needsSwitch());
    expect(screen.queryByRole("heading", { name: /^Spaces/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/pin it here/)).not.toBeInTheDocument();
    await userEvent.click(needsSwitch());
    expect(screen.getByRole("heading", { name: /^Spaces/ })).toBeInTheDocument();
  });

  it("Files draws no switch, and keeps an invisible slot so the summary line does not jump", async () => {
    renderHome(packed());
    await settled();
    await userEvent.click(tab(/^Files$/));
    expect(screen.queryByRole("button", NEEDS)).not.toBeInTheDocument();
    expect(document.querySelector(".invisible[aria-hidden='true']")).not.toBeNull();
  });

  it("Crew draws no switch and no slot at all: it lists machines, so the summary line is not there to jump", async () => {
    renderHome(packed());
    await settled();
    await userEvent.click(tab(/^Crew$/));
    expect(screen.queryByRole("button", NEEDS)).not.toBeInTheDocument();
    expect(document.querySelector(".invisible[aria-hidden='true']")).toBeNull();
  });

  it("Files lists each workspace with its counts, says No folder, and opens the workspace's Files screen", async () => {
    server.use(
      http.get(/\/api\/workspace\/w2\/changes/, () => HttpResponse.json({ workspaceId: "w2", available: false, reason: "no-folder" })),
    );
    const router = renderHome(solo());
    await settled();
    await userEvent.click(tab(/^Files$/));
    const list = await screen.findByRole("list", { name: "Changes by workspace" });
    // fixtureChanges: 3 files in webapp's root repo and 2 in packages/api, +10 −2 over all five.
    await within(list).findByText("5 files");
    await within(list).findByText("No folder");
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["webapp5 files+10 −2", "collieNo folder"]);
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(url(router)).toBe("/space/w1/changes"));
  });
});
