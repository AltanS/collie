import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import { asJsonString, parseJsonObject, type JsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { syncTricks } from "@/lib/tricks/store";
import { clearStatus, useStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { draftTargetOf, TrickSessionRoute } from "./trick-session";

// A TRICK'S OWN SESSION (M94 slice 03): the Header, the view, the actions at the foot, and no Composer.
// The tricks store is the app's own, brought to a rev the test serves at the wire.

const KEY = "lodge/legs/legs";
const TRICK_PANE: AgentView = {
  paneId: "trick:lodge:legs:legs",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:legs",
  agent: "legs",
  status: "working",
  cwd: "/home/me/.config/collie/tricks/legs",
  focused: false,
  kind: "trick",
  paneLabel: "Browser leg",
  sessionName: "Browser leg",
  subtitle: "case 24 red",
  badge: { count: 1 },
  view: KEY,
};
const REAL: AgentView = { paneId: "w6X:3", workspaceId: "w1", workspaceLabel: "collie", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/w", focused: false, paneLabel: "composer" };

function home(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [REAL],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    trickSessions: [TRICK_PANE],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...over,
  };
}

let rev = 100;
/**
 * Serve one tricks reply with the legs session part, and bring the store to it. `tabbar` adds a bar item
 * for legs and one for a second trick, tracker, after it.
 */
async function serveTricks(opts: { tabbar?: boolean; draft?: { right: boolean } } = {}): Promise<void> {
  rev += 1;
  const asOf = new Date().toISOString();
  const tabbar = opts.tabbar === true
    ? [
        { host: "lodge", trick: "legs", part: "bar", rev, asOf, value: { at: "tabbar", id: "bar", item: { label: "Legs", badge: "23/34" } } },
        { host: "lodge", trick: "tracker", part: "bar", rev, asOf, value: { at: "tabbar", id: "bar", item: { label: "Tracker" } } },
      ]
    : [];
  const legsRow: JsonObject = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["session", "tabbar"] };
  if (opts.draft?.right === true) legsRow.draftsSession = true;
  const reply = {
    rev,
    tricks: [
      legsRow,
      ...(opts.tabbar === true ? [{ host: "lodge", id: "tracker", name: "Tracker", icon: "file", on: true, state: "ok", places: ["tabbar"] }] : []),
    ],
    parts: [
      ...tabbar,
      {
        host: "lodge",
        trick: "legs",
        part: "legs",
        rev,
        asOf: new Date().toISOString(),
        value: {
          at: "session",
          id: "legs",
          name: "Browser leg",
          actions: [
            { id: "rerun", label: "Rerun red", intent: "rerun" },
            { id: "fix", label: "Ask for a fix", intent: "fix" },
          ],
          view: [
            { kind: "para", text: "23 of 34 green" },
            { kind: "list", kids: [{ kind: "row", text: "case 24", attrs: { href: "lodge:w6X:3" }, kids: [{ kind: "button", attrs: { label: "Rerun case", intent: "rerun", value: "24" } }] }] },
            ...(opts.draft === undefined ? [] : [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Use the prompt", does: "draft", value: DRAFT_TEXT } }] }]),
          ],
        },
      },
    ],
    present: [KEY, ...tabbar.map((part) => `${part.host}/${part.trick}/${part.part}`)],
  };
  server.use(http.get("/api/tricks", () => HttpResponse.json(reply)));
  await syncTricks(rev);
}

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function Status() {
  const status = useStatus();
  return <output aria-label="status">{status?.text ?? ""}</output>;
}

/** The text of the legs page's draft button: two lines, kept exactly. */
const DRAFT_TEXT = "Rerun case 24,\nthen tell me what failed.";
const TRICK_PATH = "/trick/trick%3Alodge%3Alegs%3Alegs";

function mount(path: string | { pathname: string; state: JsonObject } = TRICK_PATH, data: HomeData = home(), behind = "/") {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <>
            <Where />
            <Status />
            <Outlet />
          </>,
        ),
        children: [
          { index: true, element: <div>dashboard</div> },
          { path: "trick/:paneId", element: <TrickSessionRoute /> },
          { path: "pane/:paneId", element: <div>a pane</div> },
          { path: "hill", element: <div>the hill</div> },
        ],
      },
    ],
    { initialEntries: [behind, path], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  clearStatus();
  clearDraft({}, REAL.paneId);
});

describe("the trick session screen", () => {
  it("draws the Header with the session's name, the view in its frame and the actions, and no Composer", async () => {
    await serveTricks();
    mount();
    expect(await screen.findByRole("heading", { name: "Browser leg" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="trick-session-line"]')?.textContent).toBe("case 24 red");
    expect(await screen.findByText("23 of 34 green")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="trick-part"]')).not.toBeNull();
    expect(screen.getAllByRole("button").filter((b) => b.dataset.slot === "trick-session-action").map((b) => b.textContent)).toEqual(["Rerun red", "Ask for a fix"]);
    // No reply box, no Send, no Stop, no belt.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    expect(document.querySelector('[data-slot="belt-pins"], [data-slot="chat-input"]')).toBeNull();
  });

  it("goes back up to the Dashboard", async () => {
    await serveTricks();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("says so when the session is gone", async () => {
    mount("/trick/trick%3Alodge%3Agone%3Ax");
    expect(await screen.findByText("This trick's page is not here any more.")).toBeInTheDocument();
  });
});

describe("a tap from the trick session", () => {
  /** Serve a receipt that still carries the old draft field, as a provider on an older Collie might. */
  function tapReplies(): JsonObject[] {
    const bodies: JsonObject[] = [];
    server.use(
      http.post<never, JsonObject>("/api/tricks/lodge/legs/tap", async ({ request }) => {
        const body = await request.json();
        bodies.push(body);
        return HttpResponse.json({ rid: asJsonString(body.rid) ?? "", code: "changed", draft: { session: "lodge:w6X:3", text: "Rerun case 24" } });
      }),
    );
    return bodies;
  }

  it("never touches a reply box: a tap writes no draft, and the text already in the box stays", async () => {
    await serveTricks();
    saveDraft({}, REAL.paneId, "half a thought");
    const bodies = tapReplies();
    mount();
    // An action at the foot, and a button in the view: each goes to the provider and nowhere else.
    fireEvent.click(await screen.findByRole("button", { name: "Rerun red" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rerun case" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Rerun case" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rerun case" })).not.toBeDisabled());
    expect(loadDraft({}, REAL.paneId)).toBe("half a thought");
    expect(where()).toBe("/trick/trick%3Alodge%3Alegs%3Alegs");
    expect(screen.getByRole("status", { name: "status" }).textContent).toBe("");
  });

  it("opens the session a row's href names, one level down", async () => {
    await serveTricks();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "case 24" }));
    await waitFor(() => expect(where()).toBe("/pane/w6X%3A3"));
    // The empty box stays empty: opening a session is a move, never a draft.
    expect(loadDraft({}, REAL.paneId)).toBeNull();
  });
});

describe("the Dashboard's bar on a trick's Session (amended 2026-11-10)", () => {
  const bar = () => screen.getByRole("navigation", { name: "Dashboard views" });
  const items = () => [...bar().querySelectorAll<HTMLElement>('[data-slot="tab-extra"]')];
  afterEach(() => localStorage.clear());

  it("draws the bar under the actions with no tab selected, and nothing current when the trick has no bar item", async () => {
    await serveTricks();
    mount();
    await screen.findByRole("heading", { name: "Browser leg" });
    const tabs = [...bar().querySelectorAll<HTMLElement>('[data-slot="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Dashboard", "Files"]);
    expect(bar().querySelector('[aria-current="page"]')).toBeNull();
    // The actions sit above the bar and keep only their own air; the bar owns the safe area.
    const actions = document.querySelector<HTMLElement>('[data-slot="trick-session-actions"]')!;
    expect(actions.className).toMatch(/\bpb-3\b/u);
    expect(actions.className).not.toContain("safe-area-inset-bottom");
    expect(actions.compareDocumentPosition(bar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-slot="trick-session-scroll"]')!.contains(bar())).toBe(false);
  });

  it("marks the trick's own bar item as the current one, and a tap on it does nothing", async () => {
    await serveTricks({ tabbar: true });
    const router = mount();
    await screen.findByRole("heading", { name: "Browser leg" });
    await waitFor(() => expect(items()).toHaveLength(2));
    const [legs, tracker] = items();
    expect(legs!.dataset.trick).toBe("legs");
    expect(legs).toHaveAttribute("aria-current", "page");
    expect(legs!.className).toMatch(/\bborder-foreground\b/u);
    expect(tracker).not.toHaveAttribute("aria-current");
    for (const tab of bar().querySelectorAll('[data-slot="tab"]')) expect(tab).not.toHaveAttribute("aria-current");
    fireEvent.click(legs!);
    expect(router.state.location.pathname).toBe("/trick/trick%3Alodge%3Alegs%3Alegs");
  });

  it("a tab stores its view and goes up to the Dashboard", async () => {
    await serveTricks();
    const router = mount();
    await screen.findByRole("heading", { name: "Browser leg" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Files" }));
    await waitFor(() => expect(where()).toBe("/"));
    expect(router.state.historyAction).not.toBe("PUSH");
    expect(asJsonString(parseJsonObject(localStorage.getItem("collie:dash-prefs:v1") ?? "{}")?.dashView)).toBe("changes");
  });

  it("the Hill item opens the Hill sideways, in the Session's place", async () => {
    await serveTricks();
    const router = mount(undefined, home({ hill: true }));
    await screen.findByRole("heading", { name: "Browser leg" });
    const hill = bar().querySelector<HTMLElement>('[data-slot="tab-link"][data-link="hill"]')!;
    expect(hill).not.toHaveAttribute("aria-current");
    fireEvent.click(hill);
    await waitFor(() => expect(where()).toBe("/hill"));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("a tab steps back with POP and preserves the host or session scope carried in state.from", async () => {
    await serveTricks();
    const hostRouter = mount({ pathname: TRICK_PATH, state: { from: "/?h=peer" } }, home(), "/?h=peer");
    await screen.findByRole("heading", { name: "Browser leg" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Dashboard" }));
    await waitFor(() =>
      expect(`${hostRouter.state.location.pathname}${hostRouter.state.location.search}`).toBe("/?h=peer"),
    );
    expect(hostRouter.state.historyAction).toBe("POP");

    const sessionRouter = mount({ pathname: TRICK_PATH, state: { from: "/?s=work" } }, home(), "/?s=work");
    await screen.findAllByRole("heading", { name: "Browser leg" });
    const bars = screen.getAllByRole("navigation", { name: "Dashboard views" });
    fireEvent.click(within(bars[bars.length - 1]!).getByRole("button", { name: "Dashboard" }));
    await waitFor(() =>
      expect(`${sessionRouter.state.location.pathname}${sessionRouter.state.location.search}`).toBe("/?s=work"),
    );
    expect(sessionRouter.state.historyAction).toBe("POP");
  });

  it("the Hill item carries the host and session scope from state.from onto /hill", async () => {
    await serveTricks();
    const router = mount({ pathname: TRICK_PATH, state: { from: "/?h=peer&s=work" } }, home({ hill: true }), "/?h=peer&s=work");
    await screen.findByRole("heading", { name: "Browser leg" });
    const hill = bar().querySelector<HTMLElement>('[data-slot="tab-link"][data-link="hill"]')!;
    fireEvent.click(hill);
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/hill?h=peer&s=work"));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.state).toEqual({ from: "/?h=peer&s=work" });
  });
});

// A DRAFT BUTTON (1.29.1): `does = "draft"` puts its text into the EMPTY reply box of the session the page was
// opened for, and goes back up to that session. It never sends, and a box with words is never touched.
describe("a draft button on the trick session", () => {
  const PANE = "/pane/w6X%3A3";
  const forPane = { pathname: TRICK_PATH, state: { from: PANE, forSession: true } };
  const draftButton = () => screen.findByRole("button", { name: /^Use the prompt/u });

  it("opened for a session with an empty box: fills the box with the text exactly and goes up to that session", async () => {
    await serveTricks({ draft: { right: true } });
    const bodies: JsonObject[] = [];
    server.use(http.post<never, JsonObject>("/api/tricks/lodge/legs/tap", async ({ request }) => void bodies.push(await request.json())));
    mount(forPane, home(), PANE);
    const use = await draftButton();
    expect(use).not.toBeDisabled();
    fireEvent.click(use);
    expect(loadDraft({}, REAL.paneId)).toBe(DRAFT_TEXT);
    await waitFor(() => expect(where()).toBe(PANE));
    // Nothing went to the program, and nothing was sent.
    expect(bodies).toEqual([]);
  });

  it("a box that holds words: refuses with one line, the words stay as they were, the page stays", async () => {
    await serveTricks({ draft: { right: true } });
    saveDraft({}, REAL.paneId, "half a thought");
    mount(forPane, home(), PANE);
    fireEvent.click(await draftButton());
    expect(loadDraft({}, REAL.paneId)).toBe("half a thought");
    expect(screen.getByRole("status", { name: "status" }).textContent).toBe("The box holds your words. Send or clear them first.");
    expect(where()).toBe(TRICK_PATH);
  });

  it("opened from the Dashboard, the page is for no session: the button is disabled and says to open a session first", async () => {
    await serveTricks({ draft: { right: true } });
    mount();
    const off = await draftButton();
    expect(off).toBeDisabled();
    expect(off.textContent).toContain("Open a session first");
    expect(loadDraft({}, REAL.paneId)).toBeNull();
  });

  it("a page reached sideways keeps its from but not forSession, so it fills no box", async () => {
    await serveTricks({ draft: { right: true } });
    mount({ pathname: TRICK_PATH, state: { from: PANE } }, home(), PANE);
    expect(await draftButton()).toBeDisabled();
  });

  it("a trick whose row does not carry the right draws the button disabled, also for a session", async () => {
    await serveTricks({ draft: { right: false } });
    mount(forPane, home(), PANE);
    expect(await draftButton()).toBeDisabled();
  });
});

describe("draftTargetOf", () => {
  const root = { agents: [REAL, { ...REAL, paneId: "w2:1", host: "badger" }], servers: [], sessions: [] };

  it("is the agent pane the page was opened for, with its own address", () => {
    expect(draftTargetOf({ from: "/pane/w6X%3A3", forSession: true }, root)).toEqual({ paneId: "w6X:3", scope: {}, path: "/pane/w6X%3A3" });
    // A crew member's pane: its address carries the member, and the draft lands in that pane's box.
    expect(draftTargetOf({ from: "/pane/w2%3A1?h=badger", forSession: true }, root)).toEqual({ paneId: "w2:1", scope: { host: "badger" }, path: "/pane/w2%3A1?h=badger" });
  });

  it("is no session without forSession, from anything but a pane, or for a pane that is no listed agent session", () => {
    expect(draftTargetOf({ from: "/pane/w6X%3A3" }, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/", forSession: true }, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/pane/w6X%3A3/history", forSession: true }, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/pane/gone%3A1", forSession: true }, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/pane/w2%3A1", forSession: true }, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/pane/%E0%A4%A", forSession: true }, root)).toBeUndefined();
    expect(draftTargetOf(undefined, root)).toBeUndefined();
    expect(draftTargetOf({ from: "/pane/w6X%3A3", forSession: true }, { ...root, agents: [{ ...REAL, kind: "shell" }] })).toBeUndefined();
  });
});
