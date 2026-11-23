import { act, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { forgetAskDrafts, setAskDraft } from "@/lib/hill/asks-drafts";
import { clearAsksSendRequest, requestAsksSend } from "@/lib/hill/asks-next";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { askAddress, askDecision } from "@/test/asks-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { HillRoute } from "./hill";

// A shortcut's Send request meets a page whose list has not landed. The page waits for the list; once the list has
// landed it opens the sheet when the session is on it, and forgets the request when no board can answer it.

const KEY = askAddress("w1:p1");
const ASK = askDecision({ id: "ak_send_req1", title: "Keep the route?", address: KEY, label: "lead" });

function home(): HomeData {
  return { bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], trickSessions: [], sessions: [], servers: [], ts: 0, scope: {}, viewAll: false, snoozedUntil: null, update: undefined, error: false, authError: false, hill: true };
}

function renderHill() {
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "/", loader: () => home(), element: withHeaderHost(<Outlet />), children: [{ path: "asks", element: <HillRoute /> }] }],
    { initialEntries: ["/asks"] },
  );
  render(<RouterProvider router={router} />);
}

function listAnswers(open: ReturnType<typeof askDecision>[], rev: number) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev, open, closed: [], crewState: { state: "here", at: null, by: null, told: null } })));
}

beforeEach(() => {
  __resetHill();
  forgetAskDrafts();
  clearAsksSendRequest();
});
afterEach(() => {
  __resetHill();
  forgetAskDrafts();
  clearAsksSendRequest();
  localStorage.clear();
});

describe("a Send request that reaches the Asks page before its list", () => {
  it("opens the session's Send sheet once the list lands", async () => {
    setAskDraft(ASK.id, { intent: "keep", text: "" });
    requestAsksSend(KEY);
    renderHill();
    await screen.findByRole("heading", { name: "Asks" });
    expect(screen.queryByRole("dialog")).toBeNull();
    listAnswers([ASK], 1);
    await act(async () => {
      syncHill(1);
      await __settleHill();
    });
    expect(await screen.findByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
  });

  it("forgets the request when the list lands with no ask, so a later visit does not open a sheet", async () => {
    setAskDraft(ASK.id, { intent: "keep", text: "" });
    requestAsksSend(KEY);
    renderHill();
    await screen.findByRole("heading", { name: "Asks" });
    listAnswers([], 1);
    await act(async () => {
      syncHill(1);
      await __settleHill();
    });
    await waitFor(() => expect(document.querySelector('[data-slot="hill-empty"]')).not.toBeNull());
    // The landing pruned the drafts of asks that are gone: the mark is made again, as a person would on the later visit.
    setAskDraft(ASK.id, { intent: "keep", text: "" });
    listAnswers([ASK], 2);
    await act(async () => {
      syncHill(2);
      await __settleHill();
    });
    await waitFor(() => expect(document.querySelector('[data-slot="asks-board"]')).not.toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
