import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, type InitialEntry } from "react-router";

import { asJsonString, parseJsonObject, type JsonObject } from "@/lib/json";
import { forgetAskDrafts, useAskDrafts } from "@/lib/hill/asks-drafts";
import { __resetAskNotes } from "@/lib/hill/asks-notes";
import { __resetAsksOrder } from "@/hooks/use-asks-deck";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { AskRoute } from "./ask";
import { AskContextRoute } from "./ask-context";

// The ask screen and its context page as the app mounts them: the deck from the store, the marks in the drafts, Send through
// the bridge's route, and history that a move between asks REPLACES.

const NOW = Date.now();
const PANE = askPane("w1:p1", { label: "collie lead", cache: { warmMinutes: 38, now: NOW } });

function home(): HomeData {
  return { bridge: "connected", device: undefined, agents: [PANE], shellPanes: [], workspaces: [], tabs: [], trickSessions: [], sessions: [], servers: [], ts: 0, scope: {}, viewAll: false, snoozedUntil: null, update: undefined, error: false, authError: false, hill: true };
}

const ONE = askDecision({
  id: "ak_one", title: "Keep the old answer route?", summary: "The phone sends all answers at once now.", address: askAddress("w1:p1"), at: NOW - 14 * 3_600_000, mark: "fresh",
  recommend: "keep", why: "A phone that did not reload would lose an answer.", body: "One two three four five.", files: [{ path: "docs/plan.md", heading: "Plan" }, { path: "src/route.ts", line: 40 }], root: "w1:p1",
});
const TWO = askDecision({ id: "ak_two", title: "Drop the flag?", address: askAddress("w1:p1"), at: NOW - 3_600_000 });
const THREE = askDecision({ id: "ak_three", title: "Words please?", address: askAddress("w1:p1"), at: NOW - 1_000, words: true });

function Probe() {
  const drafts = useAskDrafts();
  return <output data-testid="drafts">{[...drafts.keys()].join(",")}</output>;
}

async function hillHolds(open: ReturnType<typeof askDecision>[], closed: ReturnType<typeof askDecision>[] = []) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed })));
  await act(async () => {
    syncHill(1);
    await __settleHill();
  });
}

function renderAsk(path: string) {
  const entries: InitialEntry[] = ["/", { pathname: "/asks", state: { from: "/" } }, { pathname: path, state: { from: "/asks" } }];
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(
          <>
            <Probe />
            <Outlet />
          </>,
        ),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "asks", element: <div data-testid="board" /> },
          { path: "asks/ask/:id", element: <AskRoute /> },
          { path: "asks/ask/:id/context", element: <AskContextRoute /> },
          { path: "files/*", element: <div data-testid="files" /> },
          { path: "pane/:paneId/*", element: <div data-testid="pane" /> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  __resetHill();
  __resetAsksOrder();
  __resetAskNotes();
});
afterEach(() => {
  act(() => forgetAskDrafts());
  localStorage.clear();
  __resetHill();
});

const here = (router: ReturnType<typeof renderAsk>) => router.state.location.pathname;

describe("the ask screen", () => {
  it("draws the header, the question, the situation, the context row, the suggestion, the hint, the cards and Your own answer last", async () => {
    await hillHolds([ONE, TWO]);
    renderAsk("/asks/ask/ak_one");
    expect(await screen.findByRole("heading", { name: "collie lead" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="ask-header-line"]')).toHaveTextContent(/^asked 14 h ago · warm, (37|38) min left$/u);
    expect(document.querySelector('[data-slot="ask-place"]')).toHaveTextContent("ask 1 of 2");
    expect(document.querySelector('[data-slot="ask-place"]')).toHaveClass("tabular-nums");
    expect(screen.getByRole("heading", { name: "Keep the old answer route?" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="ask-situation"]')).toHaveTextContent("The phone sends all answers at once now.");
    expect(document.querySelector('[data-slot="ask-context-row"]')).toHaveTextContent("Context5 words · 2 files");
    expect(document.querySelector('[data-slot="ask-suggests"]')).toHaveTextContent("collie lead suggests: Keep both routes");
    expect(document.querySelector('[data-slot="ask-hint"]')).toHaveTextContent("Tap to answer. Answers wait here until you tap Send.");
    expect(document.querySelector('[data-slot="ask-mark"]')).toHaveTextContent(/^Asked \d/u);
    const cards = [...document.querySelectorAll<HTMLElement>('[data-slot="ask-card"]')];
    expect(cards.map((card) => card.dataset.intent)).toEqual(["keep", "drop", "later", "own"]);
    expect(cards[0]?.querySelector('[data-slot="ask-card-why"]')).toHaveTextContent("A phone that did not reload would lose an answer.");
    expect(cards[1]?.querySelector('[data-slot="ask-card-why"]')).toBeNull();
    expect(cards[3]?.querySelector("button")).toHaveClass("border-dashed");
    expect(document.querySelector('[data-slot="ask-send-line"]')).toHaveTextContent("No answers yet");
  });

  it("leaves out the situation, the context row and the suggestion when the agent sent none", async () => {
    await hillHolds([TWO]);
    renderAsk("/asks/ask/ak_two");
    await screen.findByRole("heading", { name: "Drop the flag?" });
    expect(document.querySelector('[data-slot="ask-situation"]')).toBeNull();
    expect(document.querySelector('[data-slot="ask-context-row"]')).toBeNull();
    expect(document.querySelector('[data-slot="ask-suggests"]')).toBeNull();
  });

  it("says each mark in its own words", async () => {
    await hillHolds([askDecision({ id: "ak_u", title: "Stale?", address: askAddress("w1:p1"), mark: "unchecked" })]);
    renderAsk("/asks/ask/ak_u");
    await screen.findByRole("heading", { name: "Stale?" });
    expect(document.querySelector('[data-slot="ask-mark"]')).toHaveTextContent("You wrote in this session since. Not checked.");
  });

  it("marks an answer from a card tap, stores a draft, sends nothing and moves nowhere", async () => {
    let posted = 0;
    server.use(
      http.post(/\/api\/hill\/answers$/, () => {
        posted += 1;
        return HttpResponse.json({});
      }),
    );
    await hillHolds([ONE, TWO]);
    const router = renderAsk("/asks/ask/ak_one");
    await userEvent.click(await screen.findByRole("button", { name: /Drop the old route/u }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add a note/u }));
    await userEvent.type(within(dialog).getByRole("textbox"), "after the next minor");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("drafts")).toHaveTextContent("ak_one");
    const card = document.querySelector('[data-slot="ask-card"][data-intent="drop"]')!;
    expect(card).toHaveAttribute("data-state", "answered");
    expect(card.querySelector('[data-slot="ask-card-foot"]')).toHaveTextContent("Note: after the next minor");
    expect(document.querySelector('[data-slot="ask-send-line"]')).toHaveTextContent("1 of 2 answered·Send 1");
    expect(here(router)).toBe("/asks/ask/ak_one");
    expect(posted).toBe(0);
  });

  it("opens Your own answer with a required field", async () => {
    await hillHolds([TWO]);
    renderAsk("/asks/ask/ak_two");
    await userEvent.click(await screen.findByRole("button", { name: /Your own answer/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("takes a words ask in one card", async () => {
    await hillHolds([THREE]);
    renderAsk("/asks/ask/ak_three");
    await screen.findByRole("heading", { name: "Words please?" });
    expect(document.querySelectorAll('[data-slot="ask-card"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ask back" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Write your answer/u }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("walks the deck with Previous and Next and REPLACES the history entry", async () => {
    await hillHolds([ONE, TWO]);
    const router = renderAsk("/asks/ask/ak_one");
    const previous = await screen.findByRole("button", { name: /Previous/u });
    const next = screen.getByRole("button", { name: /Next/u });
    expect(previous).toBeDisabled();
    const length = window.history.length;
    await userEvent.click(next);
    expect(here(router)).toBe("/asks/ask/ak_two");
    expect(await screen.findByRole("button", { name: /Next/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Previous/u })).toBeEnabled();
    await act(() => router.navigate(-1));
    expect(here(router)).toBe("/asks");
    expect(window.history.length).toBe(length);
  });

  it("moves with the keys, picks with a digit, and leaves the keys alone while a field has the focus", async () => {
    await hillHolds([ONE, TWO]);
    const router = renderAsk("/asks/ask/ak_one");
    await screen.findByRole("heading", { name: "Keep the old answer route?" });
    await userEvent.keyboard("j");
    expect(here(router)).toBe("/asks/ask/ak_two");
    await userEvent.keyboard("k");
    expect(here(router)).toBe("/asks/ask/ak_one");
    await userEvent.keyboard("2");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Drop the old route");
    const field = within(dialog).getByRole("textbox", { name: /Note for the agent/u });
    await userEvent.type(field, "jk");
    expect(field).toHaveValue("jk");
    expect(here(router)).toBe("/asks/ask/ak_one");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.keyboard("{Escape}");
    expect(here(router)).toBe("/asks");
  });

  it("sends the marked answers of the session in one request and clears the drafts", async () => {
    const bodies: JsonObject[] = [];
    server.use(
      http.post(/\/api\/hill\/answers$/, async ({ request }) => {
        const sent = parseJsonObject(await request.text()) ?? {};
        bodies.push(sent);
        return HttpResponse.json({ rid: asJsonString(sent.rid) ?? "", items: [{ id: "ak_one", code: "ok", reason: null, state: "answered" }], delivery: "typed", at: NOW });
      }),
    );
    await hillHolds([ONE, TWO]);
    renderAsk("/asks/ask/ak_one");
    await userEvent.click(await screen.findByRole("button", { name: /Keep both routes/u }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Review and send" }));
    const sheet = await screen.findByRole("dialog", { name: "Send to collie lead" });
    expect(within(sheet).getByText(/ak_two "Drop the flag\?": no answer yet, it stays open\./u)).toBeInTheDocument();
    server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 2, open: [TWO], closed: [] })));
    await userEvent.click(within(sheet).getByRole("button", { name: "Send 1" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ answers: [{ id: "ak_one", intent: "keep" }] });
    await waitFor(() => expect(screen.getByTestId("drafts")).toHaveTextContent(/^$/u));
  });

  it("keeps the marks and says so in plain words when the bridge refuses the whole Send", async () => {
    server.use(http.post(/\/api\/hill\/answers$/, () => HttpResponse.json({ code: "not_answering", error: "away", machine: "workshop" }, { status: 409 })));
    await hillHolds([TWO]);
    renderAsk("/asks/ask/ak_two");
    await userEvent.click(await screen.findByRole("button", { name: /Decide next week/u }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Review and send" }));
    const sheet = await screen.findByRole("dialog", { name: "Send to collie lead" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Send 1" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("workshop is not answering. Nothing was sent.");
    expect(screen.getByTestId("drafts")).toHaveTextContent("ak_two");
  });

  it("sends once for two quick taps", async () => {
    let posted = 0;
    server.use(
      http.post(/\/api\/hill\/answers$/, async () => {
        posted += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return HttpResponse.json({ rid: "x", items: [{ id: "ak_two", code: "ok", reason: null, state: "answered" }], delivery: "typed", at: NOW });
      }),
    );
    await hillHolds([TWO]);
    renderAsk("/asks/ask/ak_two");
    await userEvent.click(await screen.findByRole("button", { name: /Decide next week/u }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Review and send" }));
    const go = within(await screen.findByRole("dialog")).getByRole("button", { name: "Send 1" });
    await act(async () => {
      go.click();
      go.click();
    });
    await waitFor(() => expect(posted).toBe(1));
  });

  it("says what happened on an ask that is closed or not on the board, with the way back", async () => {
    await hillHolds([TWO], [askDecision({ id: "ak_gone", title: "Old question?", address: askAddress("w1:p1"), state: "withdrawn", closedReason: "conversation cleared" })]);
    const router = renderAsk("/asks/ask/ak_gone");
    expect(await screen.findByText("The conversation was cleared. This ask is closed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Old question?" })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Back to the board" })[0]!);
    expect(here(router)).toBe("/asks");
  });

  it("says an unknown id is not on the board", async () => {
    await hillHolds([TWO]);
    renderAsk("/asks/ask/ak_nope");
    expect(await screen.findByText("This ask is not on the board.")).toBeInTheDocument();
  });

  it("goes up to the board with the header arrow", async () => {
    await hillHolds([TWO]);
    const router = renderAsk("/asks/ask/ak_two");
    await userEvent.click(await screen.findByRole("button", { name: "Back to the board" }));
    expect(here(router)).toBe("/asks");
  });
});

describe("the context page", () => {
  it("opens one level below the ask and goes back up to it", async () => {
    await hillHolds([ONE]);
    const router = renderAsk("/asks/ask/ak_one");
    await userEvent.click(await screen.findByRole("button", { name: /Context/u }));
    expect(here(router)).toBe("/asks/ask/ak_one/context");
    expect(await screen.findByRole("heading", { name: "Context for this ask" })).toBeInTheDocument();
    expect(screen.getByText("One two three four five.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to the answers" }));
    expect(here(router)).toBe("/asks/ask/ak_one");
  });

  it("lists the linked files and opens one in the Files preview", async () => {
    await hillHolds([ONE]);
    const router = renderAsk("/asks/ask/ak_one/context");
    expect(await screen.findByText("docs/plan.md")).toBeInTheDocument();
    expect(screen.getByText("#Plan")).toBeInTheDocument();
    expect(screen.getByText("line 40")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open docs/plan.md" }));
    expect(here(router)).toContain("/changes");
  });
});
