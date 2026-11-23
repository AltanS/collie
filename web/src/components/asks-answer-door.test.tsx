import { act, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { AsksAnswerDoor } from "@/components/asks-answer-door";
import { __resetAsksOrder } from "@/hooks/use-asks-deck";
import { forgetAskDrafts, setAskDraft } from "@/lib/hill/asks-drafts";
import { clearAsksSendRequest, useAsksSendRequest } from "@/lib/hill/asks-next";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetShortcutRegistry, isShortcutActionAvailable, runShortcutAction } from "@/lib/shortcuts/registry";
import { askAddress, askDecision } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// "Answer the next ask" is offered while Asks is on and one ask is open, on any screen, and not otherwise. Running it does
// what the Next up button does: the first ask with no answer marked, or Send's sheet request when only Send is left.

function home(over: Partial<HomeData> = {}): HomeData {
  return { bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], servers: [], ts: 0, scope: {}, viewAll: false, snoozedUntil: null, update: undefined, error: false, authError: false, trickSessions: [], hill: true, ...over };
}

const ASK_A = askDecision({ id: "ak_a", address: askAddress("w1:p1"), at: HILL_T0 });
const ASK_B = askDecision({ id: "ak_b", address: askAddress("w1:p1"), at: HILL_T0 + 1 });

function Probe() {
  return <span data-testid="request">{useAsksSendRequest() ?? "none"}</span>;
}

function mount(data: HomeData, path = "/") {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: (
          <>
            <AsksAnswerDoor />
            <Probe />
            <Outlet />
          </>
        ),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "asks", element: <div data-testid="board" /> },
          { path: "asks/ask/:id", element: <div data-testid="ask" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function hold(open: ReturnType<typeof askDecision>[]) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1);
    await __settleHill();
  });
}

beforeEach(() => {
  __resetHill();
  __resetAsksOrder();
  forgetAskDrafts();
});
afterEach(() => {
  __resetShortcutRegistry();
  clearAsksSendRequest();
  forgetAskDrafts();
});

describe("the action answer_next_ask", () => {
  it("is offered with Asks on and an ask open, on the Dashboard as on the board", async () => {
    await hold([ASK_A]);
    mount(home());
    await waitFor(() => expect(isShortcutActionAvailable("answer_next_ask")).toBe(true));
  });

  it("is not offered with no ask open", async () => {
    await hold([]);
    mount(home());
    await act(async () => undefined);
    expect(isShortcutActionAvailable("answer_next_ask")).toBe(false);
  });

  it("is not offered with Asks switched off, or on a bridge with no Hill", async () => {
    await hold([ASK_A]);
    mount(home({ hillOff: true }));
    await act(async () => undefined);
    expect(isShortcutActionAvailable("answer_next_ask")).toBe(false);
    __resetShortcutRegistry();
    mount(home({ hill: false }));
    await act(async () => undefined);
    expect(isShortcutActionAvailable("answer_next_ask")).toBe(false);
  });

  it("opens the first ask that has no answer marked, one level down from another screen", async () => {
    await hold([ASK_A, ASK_B]);
    setAskDraft("ak_a", { intent: "keep", text: "" });
    const router = mount(home());
    await waitFor(() => expect(isShortcutActionAvailable("answer_next_ask")).toBe(true));
    act(() => void runShortcutAction("answer_next_ask"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/asks/ask/ak_b"));
  });

  it("replaces the entry when it runs from an ask of the deck", async () => {
    await hold([ASK_A, ASK_B]);
    const router = mount(home(), "/asks/ask/ak_b");
    await waitFor(() => expect(isShortcutActionAvailable("answer_next_ask")).toBe(true));
    act(() => void runShortcutAction("answer_next_ask"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/asks/ask/ak_a"));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("asks the board for the Send sheet when every ask has an answer, and goes to the board", async () => {
    await hold([ASK_A, ASK_B]);
    setAskDraft("ak_a", { intent: "keep", text: "" });
    setAskDraft("ak_b", { intent: "keep", text: "" });
    const router = mount(home());
    await waitFor(() => expect(isShortcutActionAvailable("answer_next_ask")).toBe(true));
    act(() => void runShortcutAction("answer_next_ask"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/asks"));
    expect(screen.getByTestId("request")).toHaveTextContent(askAddress("w1:p1"));
  });
});
