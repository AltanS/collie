import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { SpaceStrip } from "@/components/space-strip";
import { __resetProgramLists } from "@/lib/conversation-list";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { __resetOperatorCommands, getMuxConfig } from "@/lib/operator-config";
import { __resetSessionCards, noteSessionCards } from "@/lib/session-cards";
import type { AgentView, MuxCapability, MuxConfig, ServerSummary, SessionSummary } from "@/lib/types";
import { fixtureAgents, fixtureSessions, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { DetailRoute } from "./detail";
import { HomeRoute } from "./home";

// A PROGRAM IS A SESSION, ON THE PHONE (M55 spec 02, spec 13), through the real home route: a durable
// program the collie carries is a row of the dashboard's Durable agents section, which sits above the spaces
// while a question waits and below them otherwise, a tap opens its conversation list, and a snapshot with
// no program session renders exactly as it did before the session card existed.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
vi.mock("@/components/crew-tab", () => ({ CrewTab: () => <div data-testid="crew-tab" /> }));
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ onBackArrow }: { onBackArrow?: () => void }) => (
    <button type="button" onClick={onBackArrow}>
      back
    </button>
  ),
}));

/** The machine's own block, a terminal multiplexer with a screen. */
const TERMINAL_CAPS = { paneGrid: true, createSpace: true, agentDetection: true } satisfies Partial<Record<MuxCapability, boolean>>;

function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

function session(over: Partial<SessionSummary> & { name: string }): SessionSummary {
  return { isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0, ...over };
}

const DESK = session({
  name: "desk",
  kind: "program",
  mux: "pi-durable",
  caps: { paneGrid: false, createSpace: false, starters: true },
  where: "local",
  state: "ready",
  experimental: true,
});
const BILLING = session({
  name: "billing",
  kind: "program",
  mux: "acme-billing",
  caps: { paneGrid: false },
  where: "remote",
  state: "unreachable",
  reachable: false,
  experimental: true,
});

/** The fixture registry as an M55 bridge sends it: the same rows, each with a terminal card. */
const TERMINAL_CARDS: SessionSummary[] = fixtureSessions.map((s) => ({
  ...s,
  kind: "terminal",
  mux: "reference",
  caps: { ...TERMINAL_CAPS },
  where: "local",
  state: "ready",
  experimental: false,
}));

function homeData(sessions: SessionSummary[], scope: HomeData["scope"] = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    workspaces: fixtureWorkspaces,
    tabs: fixtureTabs,
    sessions,
    servers: [],
    ts: 0,
    scope,
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function renderHome(data: HomeData, initialPath = "/", read: () => HomeData = () => data) {
  // The root loader files the cards on every snapshot (lib/loaders.ts `toHomeData`); a test loader does
  // what it does. `read` stands for a bridge whose next snapshot differs, asked on each revalidation.
  const first = data;
  noteSessionCards(first.sessions, first.servers);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => {
          const next = read();
          noteSessionCards(next.sessions, next.servers);
          return next;
        },
        element: withHeaderHost(
          <CrewProvider servers={first.servers} sessions={first.sessions} ts={first.ts} pollMs={1500}>
            <HomeRoute />
          </CrewProvider>,
        ),
      },
      { path: "/new", element: <div data-testid="new-page" /> },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
      { path: "/space/:spaceId", element: <div data-testid="space" /> },
    ],
    { initialEntries: [initialPath] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, container: view.container };
}

/** The page's markup with the per-mount ids taken out: React's `useId` counts on across roots. */
function markup(container: HTMLElement): string {
  return container.innerHTML
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "<id>")
    .replace(/blob:collie-test\/\d+/g, "blob:<n>");
}

beforeEach(() => {
  __resetOperatorCommands();
  __resetProgramLists();
  // The Spaces section open, so its rows are on the page.
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ spacesOpen: true }));
});
afterEach(() => {
  __resetOperatorCommands();
});

/** Wait for the Spaces list's body: the dashboard has answered and the section is open. */
async function spacesShown(): Promise<void> {
  await waitFor(() => expect(document.querySelector("#spaces-body")).not.toBeNull());
}

const programRows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="program-space"]')];
const programSection = () => document.querySelector<HTMLElement>('[data-slot="program-section"]');
/** Whether any heading on the page reads "Durable agents". */
const programsHeading = (container: HTMLElement) =>
  [...container.querySelectorAll("h2, h3")].some((h) => (h.textContent ?? "").includes("Durable agents"));
/** The section wrapping the Spaces list's body. */
const spacesSection = () => document.querySelector("#spaces-body")!.closest("section")!;
/** Whether `a` comes before `b` in the document. */
const precedes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("session card: a snapshot with no program session renders as before", () => {
  it("the dashboard, the Spaces list and the tab bar are the same markup with and without terminal cards", async () => {
    declares(TERMINAL_CAPS);
    const before = renderHome(homeData(fixtureSessions));
    await waitFor(() => expect(getMuxConfig()).not.toBeNull());
    await spacesShown();
    const old = markup(before.container);
    cleanup();
    __resetSessionCards();

    const after = renderHome(homeData(TERMINAL_CARDS));
    await spacesShown();
    expect(markup(after.container)).toBe(old);
    expect(programRows()).toHaveLength(0);
    expect(document.querySelector('[data-slot="experimental-badge"]')).toBeNull();
    // No program, no Durable agents section: not even its header (M55 spec 13).
    expect(programSection()).toBeNull();
    expect(programsHeading(before.container)).toBe(false);
    expect(programsHeading(after.container)).toBe(false);
  });

  it("a named terminal session's view is the same markup with and without its card", async () => {
    declares(TERMINAL_CAPS);
    const scope = { session: "collie-demo" };
    const before = renderHome(homeData(fixtureSessions, scope), "/?s=collie-demo");
    await waitFor(() => expect(getMuxConfig()).not.toBeNull());
    await spacesShown();
    // The card-less session asks its own block, which an M55 bridge answers as the machine's.
    await waitFor(() => expect(before.container.querySelector('[aria-label="New space"]')).not.toBeNull());
    const old = markup(before.container);
    cleanup();
    __resetSessionCards();

    const after = renderHome(homeData(TERMINAL_CARDS, scope), "/?s=collie-demo");
    await spacesShown();
    expect(markup(after.container)).toBe(old);
    expect(programsHeading(after.container)).toBe(false);
  });

  it("the space strip is the same markup with and without the session's card", async () => {
    declares(TERMINAL_CAPS);
    const strip = () =>
      render(
        <SpaceStrip
          workspaces={fixtureWorkspaces}
          agents={fixtureAgents}
          selected={null}
          onSelect={() => {}}
          onNewSpace={() => {}}
          scope={{ session: "collie-demo" }}
        />,
      );
    const before = strip();
    await waitFor(() => expect(before.container.querySelector('[aria-label="New space"]')).not.toBeNull());
    const old = markup(before.container);
    cleanup();
    noteSessionCards(TERMINAL_CARDS, undefined);
    const after = strip();
    expect(markup(after.container)).toBe(old);
  });
});

describe("Durable agents section: one row per program session, apart from the Spaces list", () => {
  it("draws each program session as a row with its name, the Experimental badge, its runtime and its place", async () => {
    declares(TERMINAL_CAPS);
    renderHome(homeData([...TERMINAL_CARDS, DESK, BILLING]));
    await spacesShown();
    const rows = programRows();
    expect(rows.map((r) => r.querySelector('[data-slot="program-space-name"]')?.textContent)).toEqual(["desk", "billing"]);

    const desk = rows[0]!;
    expect(within(desk).getByText("Experimental")).toBeInTheDocument();
    expect(desk.querySelector('[data-slot="program-space-open"]')?.textContent).toBe("00 open conversations");
    expect(desk.querySelector('[data-slot="program-space-line"]')?.textContent).toBe("pi-durable, local");
    // Ready says nothing on screen; the word is there for a screen reader.
    expect(desk.querySelector('[data-slot="program-space-state"]')).toBeNull();
    expect(within(desk).getByText("Ready")).toHaveClass("sr-only");

    const billing = rows[1]!;
    expect(billing.dataset.state).toBe("unreachable");
    expect(billing.querySelector('[data-slot="program-space-state"]')?.textContent).toBe("Unreachable");
    expect(billing.querySelector('[data-slot="program-space-line"]')?.textContent).toBe("acme-billing, remote");
  });

  it("lists the programs under a Durable agents header, and never in the Spaces list", async () => {
    declares(TERMINAL_CAPS);
    const { container } = renderHome(homeData([...TERMINAL_CARDS, DESK, BILLING]));
    await spacesShown();
    expect(programsHeading(container)).toBe(true);
    expect(programSection()!.querySelectorAll('[data-slot="program-space"]')).toHaveLength(2);
    expect(container.querySelector("#spaces-body")!.querySelector('[data-slot="program-space"]')).toBeNull();
    // A program is never shown twice.
    expect(programRows()).toHaveLength(2);
  });

  it("sits below the spaces while no question waits", async () => {
    declares(TERMINAL_CAPS);
    renderHome(homeData([...TERMINAL_CARDS, { ...DESK, agents: 3 }, BILLING]));
    await spacesShown();
    expect(precedes(spacesSection(), programSection()!)).toBe(true);
  });

  it("sits above the spaces while any program has a question waiting", async () => {
    declares(TERMINAL_CAPS);
    renderHome(homeData([...TERMINAL_CARDS, { ...DESK, agents: 3, blocked: 2 }, BILLING]));
    await spacesShown();
    expect(precedes(programSection()!, spacesSection())).toBe(true);
    const waiting = programRows()[0]!.querySelector('[data-slot="program-space-waiting"]');
    expect(waiting).toHaveClass("text-status-blocked");
  });

  it("moves on the snapshot that changes the waiting count, both ways", async () => {
    declares(TERMINAL_CAPS);
    let blocked = 0;
    const snapshot = () => homeData([...TERMINAL_CARDS, { ...DESK, agents: 2, blocked }]);
    const { router } = renderHome(snapshot(), "/", snapshot);
    await spacesShown();
    expect(precedes(spacesSection(), programSection()!)).toBe(true);

    blocked = 1;
    await router.revalidate();
    await waitFor(() => expect(precedes(programSection()!, spacesSection())).toBe(true));

    blocked = 0;
    await router.revalidate();
    await waitFor(() => expect(precedes(spacesSection(), programSection()!)).toBe(true));
    expect(programRows()).toHaveLength(1);
  });

  it("with the needs-you filter on, lists only the programs that wait, and nothing when none waits", async () => {
    declares(TERMINAL_CAPS);
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ spacesOpen: true, needsYouOnly: true }));
    const quiet = { ...DESK, name: "quiet", agents: 2 };
    let blocked = 2;
    const snapshot = () => homeData([...TERMINAL_CARDS, { ...DESK, agents: 3, blocked }, quiet, BILLING]);
    const { container, router } = renderHome(snapshot(), "/", snapshot);
    await waitFor(() => expect(programSection()).not.toBeNull());
    expect(programRows().map((r) => r.querySelector('[data-slot="program-space-name"]')?.textContent)).toEqual(["desk"]);
    // The filter hides Launch and the Spaces list; the section stays.
    expect(container.querySelector("#spaces-body")).toBeNull();
    expect(programsHeading(container)).toBe(true);

    blocked = 0;
    await router.revalidate();
    await waitFor(() => expect(programSection()).toBeNull());
    expect(programsHeading(container)).toBe(false);
  });

  it("in a crew, one section lists every machine's programs, names the member, and opens it on its machine", async () => {
    declares(TERMINAL_CAPS);
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })));
    const servers: ServerSummary[] = [
      { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
      { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
    ];
    const sessions = [
      ...TERMINAL_CARDS.map((s) => ({ ...s, host: "bluefin" })),
      { ...DESK, host: "bluefin" },
      { ...DESK, name: "support", host: "minibuch" },
    ];
    const { router } = renderHome({ ...homeData(sessions), servers });
    await spacesShown();
    const rows = programRows();
    expect(rows.map((r) => r.querySelector('[data-slot="program-space-line"]')?.textContent)).toEqual([
      "pi-durable, local",
      "pi-durable, local, minibuch",
    ]);
    await userEvent.click(rows[1]!);
    await waitFor(() => expect(router.state.location.search).toBe("?h=minibuch&s=support"));
  });

  it("a starting session says so on its row", async () => {
    declares(TERMINAL_CAPS);
    renderHome(homeData([...TERMINAL_CARDS, { ...DESK, state: "starting" }]));
    await spacesShown();
    expect(programRows()[0]!.querySelector('[data-slot="program-space-state"]')?.textContent).toBe("Starting");
  });

  it("the tap opens the program session's home, its conversation list", async () => {
    declares(TERMINAL_CAPS);
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })));
    const { router } = renderHome(homeData([...TERMINAL_CARDS, DESK]));
    await spacesShown();
    await userEvent.click(programRows()[0]!);
    await waitFor(() => expect(router.state.location.search).toBe("?s=desk"));
    expect(router.state.location.pathname).toBe("/");
  });

  it("a program session's home is its conversation list, asked of the session and not the machine", async () => {
    // The machine has a screen; the session named in the URL does not. Capabilities per session.
    declares(TERMINAL_CAPS);
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })));
    renderHome(homeData([...TERMINAL_CARDS, DESK], { session: "desk" }), "/?s=desk");
    await waitFor(() => expect(document.querySelector('[data-slot="conversation-list"]')).not.toBeNull());
    // No Spaces list, no Durable agents section and no Files tab on a session with no screen.
    expect(document.querySelector("#spaces-body")).toBeNull();
    expect(programSection()).toBeNull();
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
  });

  it("the primary session's home on the same collie is the terminal dashboard", async () => {
    declares(TERMINAL_CAPS);
    renderHome(homeData([...TERMINAL_CARDS, DESK]));
    await spacesShown();
    expect(document.querySelector('[data-slot="conversation-list"]')).toBeNull();
  });
});

describe("program space: the back path stays in the session", () => {
  it("the back arrow of a program session's conversation lands on that session's list", async () => {
    declares(TERMINAL_CAPS);
    noteSessionCards([...TERMINAL_CARDS, DESK], undefined);
    const pane: AgentView = { ...fixtureAgents[0]!, paneId: "c1", workspaceId: "w1" };
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => ({ ...homeData([...TERMINAL_CARDS, DESK], { session: "desk" }), agents: [pane], shellPanes: [] }),
          element: <Outlet />,
          children: [
            { index: true, element: <div data-testid="home">HOME</div> },
            { path: "space/:id", element: <div data-testid="space">SPACE</div> },
            {
              path: "pane/:paneId",
              loader: ({ params }): PaneData => ({
                paneId: params.paneId ?? "",
                scope: { session: "desk" },
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
      {
        initialEntries: ["/space/w1?s=desk", { pathname: panePath(pane.paneId), search: "?s=desk", state: { from: "/space/w1?s=desk" } }],
        initialIndex: 1,
      },
    );
    render(<RouterProvider router={router} />);
    await userEvent.click(await screen.findByRole("button", { name: "back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toBe("?s=desk");
  });
});
