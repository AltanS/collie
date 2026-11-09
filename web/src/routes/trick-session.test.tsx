import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import { asJsonString, type JsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { syncTricks } from "@/lib/tricks/store";
import { clearStatus, useStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { TrickSessionRoute } from "./trick-session";

// A TRICK'S OWN SESSION (M94 slice 03): the Header, the view, the actions at the foot, and no Composer.
// The tricks store is the app's own, brought to a rev the test serves at the wire.

const KEY = "bluefin/legs/legs";
const TRICK_PANE: AgentView = {
  paneId: "trick:bluefin:legs:legs",
  workspaceId: "trick:bluefin",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:bluefin:legs",
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

function home(): HomeData {
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
  };
}

let rev = 100;
/** Serve one tricks reply with the legs session part, and bring the store to it. */
async function serveTricks(): Promise<void> {
  rev += 1;
  const reply = {
    rev,
    tricks: [{ host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["session"] }],
    parts: [
      {
        host: "bluefin",
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
            { kind: "list", kids: [{ kind: "row", text: "case 24", attrs: { href: "bluefin:w6X:3" }, kids: [{ kind: "button", attrs: { label: "Rerun case", intent: "rerun", value: "24" } }] }] },
          ],
        },
      },
    ],
    present: [KEY],
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

function mount(path = "/trick/trick%3Abluefin%3Alegs%3Alegs") {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => home(),
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
        ],
      },
    ],
    { initialEntries: ["/", path], initialIndex: 1 },
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
    mount("/trick/trick%3Abluefin%3Agone%3Ax");
    expect(await screen.findByText("This trick session is not here any more.")).toBeInTheDocument();
  });
});

describe("a tap from the trick session", () => {
  /** Serve a receipt that still carries the old draft field, as a provider on an older Collie might. */
  function tapReplies(): JsonObject[] {
    const bodies: JsonObject[] = [];
    server.use(
      http.post<never, JsonObject>("/api/tricks/bluefin/legs/tap", async ({ request }) => {
        const body = await request.json();
        bodies.push(body);
        return HttpResponse.json({ rid: asJsonString(body.rid) ?? "", code: "changed", draft: { session: "bluefin:w6X:3", text: "Rerun case 24" } });
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
    expect(where()).toBe("/trick/trick%3Abluefin%3Alegs%3Alegs");
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
