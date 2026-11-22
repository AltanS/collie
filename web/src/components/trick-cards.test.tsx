import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, type InitialEntry } from "react-router";

import { firstSentence, TrickCardsLine, TrickCardsLineView, TrickCardsWaiting, TrickCardsWaitingList, trickLineOf } from "@/components/trick-cards";
import { APPROVE_HOLD_MS, ARM_DWELL_MS } from "@/lib/arm";
import { __resetHill, __settleHill, noteHillAnswer, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { TrickCardRoute } from "@/routes/trick-card";
import { withHeaderHost } from "@/test/header-host";
import type { HillDecision } from "@/lib/hill/wire";
import { collieCard, HILL_T0, hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// A TRICK'S CARD NEEDS NO HILL (M96 spec 14): the group in Settings, Tricks, the Dashboard's line while the
// Hill is off, and the card's own page, which draws the Hill's card with no Hill around it.

async function holds(open: ReturnType<typeof hillDecision>[], scope: "all" | "tricks" = "tricks") {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1, scope);
    await __settleHill();
  });
}

/** The pieces under the root route, as the app mounts them: the Dashboard, Settings, Tricks and the card page. */
function renderApp(entries: InitialEntry[], data: Pick<HomeData, "hillOff" | "trickCards">) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home"><TrickCardsLine /></div> },
          { path: "settings/tricks", element: <div data-testid="tricks"><TrickCardsWaiting /></div> },
          { path: "trick-card/:decisionId", element: <TrickCardRoute /> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => __resetHill());
afterEach(() => __resetHill());

describe("Waiting for your yes, in Settings, Tricks", () => {
  it("draws nothing while no card waits", () => {
    const { container } = render(<TrickCardsWaitingList cards={[]} onOpen={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("one row per card: its title and who proposed it, a tap opens it", async () => {
    const card = collieCard("proposal", "legs");
    const opened: string[] = [];
    render(<TrickCardsWaitingList cards={[card]} onOpen={(d) => opened.push(d.id)} />);
    expect(screen.getByRole("heading", { name: "Waiting for your yes" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Switch on the trick legs\?/u });
    expect(row).toHaveTextContent("A session on lodge proposes it.");
    expect(row).not.toHaveTextContent("It reaches the network.");
    expect(row.className).toContain("min-h-11");
    await userEvent.click(row);
    expect(opened).toEqual([card.id]);
  });

  it("firstSentence keeps the first sentence, or the whole text", () => {
    expect(firstSentence("One proposes it. Two.")).toBe("One proposes it.");
    expect(firstSentence("no end")).toBe("no end");
  });

  it("lists only the cards of Collie's own about a trick, from the store", async () => {
    await holds([hillDecision({ title: "An agent asks" }), collieCard("rights", "legs")], "all");
    renderApp(["/settings/tricks"], { hillOff: false, trickCards: true });
    expect(await screen.findByText("Switch on the trick legs?")).toBeInTheDocument();
    expect(screen.queryByText("An agent asks")).toBeNull();
  });
});

/** A card of Collie's own with a display name on its `from`, as a current bridge sends it. */
function named(type: Parameters<typeof collieCard>[0], id: string, name: string, over: Partial<HillDecision> = {}): HillDecision {
  const card = collieCard(type, id, over);
  return { ...card, from: { ...card.from, name } };
}

describe("the Dashboard's line", () => {
  it("names the trick when one proposal waits, and Review opens it", async () => {
    const card = named("proposal", "idle-sessions", "Idle Sessions", { at: HILL_T0 + 1 });
    await holds([card]);
    const router = renderApp(["/"], { hillOff: true, trickCards: true });
    expect(await screen.findByText("An agent proposes a trick:")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="trick-waits"]')).toHaveTextContent("An agent proposes a trick: Idle Sessions.");
    expect(screen.queryByText(/waits for your yes/u)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(router.state.location.pathname).toBe(`/trick-card/${card.id}`);
  });

  it("falls back to the id when an older bridge sent no name", async () => {
    await holds([collieCard("proposal", "idle-sessions")]);
    renderApp(["/"], { hillOff: true, trickCards: true });
    await screen.findByText("An agent proposes a trick:");
    expect(document.querySelector('[data-slot="trick-waits"]')).toHaveTextContent("An agent proposes a trick: idle-sessions.");
  });

  it("counts them when several proposals wait, and Review opens the oldest", async () => {
    const newest = collieCard("proposal", "legs", { at: HILL_T0 + 3 });
    const oldest = collieCard("proposal", "git", { at: HILL_T0 + 1 });
    const middle = collieCard("proposal", "clock", { at: HILL_T0 + 2, title: "Use the new version of clock?" });
    await holds([newest, oldest, middle]);
    const router = renderApp(["/"], { hillOff: true, trickCards: true });
    expect(await screen.findByText("Agents propose 3 tricks.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(router.state.location.pathname).toBe(`/trick-card/${oldest.id}`);
  });

  it("says a new version when the one proposal is a version of an installed trick", async () => {
    await holds([named("proposal", "legs", "Browser leg", { title: "Use the new version of legs?" })]);
    renderApp(["/"], { hillOff: true, trickCards: true });
    await screen.findByText("An agent proposes a new version of");
    expect(document.querySelector('[data-slot="trick-waits"]')).toHaveTextContent("An agent proposes a new version of Browser leg.");
  });

  it("says a card that is no proposal needs a look, by name when it is alone", async () => {
    await holds([named("rights", "legs", "Browser leg")]);
    renderApp(["/"], { hillOff: true, trickCards: true });
    await screen.findByText("needs a look.");
    expect(document.querySelector('[data-slot="trick-waits"]')).toHaveTextContent("Browser leg needs a look.");
    expect(screen.queryByText(/waits for your yes/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("counts the cards when several wait and any is no proposal", async () => {
    await holds([collieCard("version", "legs"), collieCard("proposal", "git", { at: HILL_T0 + 5 })]);
    renderApp(["/"], { hillOff: true, trickCards: true });
    expect(await screen.findByText("2 trick cards need a look.")).toBeInTheDocument();
  });

  it("is not drawn with the Hill on: the bar's Hill item is the signal", async () => {
    await holds([collieCard("proposal", "legs")], "all");
    renderApp(["/"], { trickCards: true });
    await screen.findByTestId("home");
    expect(screen.queryByText(/An agent proposes/u)).toBeNull();
    expect(document.querySelector('[data-slot="trick-waits"]')).toBeNull();
  });

  it("is not drawn while no card waits", async () => {
    renderApp(["/"], { hillOff: true, trickCards: false });
    await screen.findByTestId("home");
    expect(document.querySelector('[data-slot="trick-waits"]')).toBeNull();
  });

  it("cuts a long name with an ellipsis on one line and keeps the button in the box", () => {
    const long = "a".repeat(40);
    render(<TrickCardsLineView cards={[named("proposal", "legs", long)]} onOpen={() => undefined} />);
    const name = document.querySelector('[data-slot="trick-name"]');
    expect(name).toHaveTextContent(long);
    expect(name?.className).toContain("truncate");
    expect(name?.className).toContain("min-w-0");
    expect(name?.parentElement?.className).toContain("min-w-0");
    expect(name?.previousElementSibling?.className).toContain("shrink-0");
    expect(name?.nextElementSibling?.className).toContain("shrink-0");
    expect(screen.getByRole("button", { name: "Review" }).className).toContain("h-6");
  });

  it("draws the name as its own element, a chip in medium weight, so an agent's words never read as Collie's sentence", () => {
    render(<TrickCardsLineView cards={[named("proposal", "legs", "Collie says approve this now")]} onOpen={() => undefined} />);
    const name = document.querySelector<HTMLElement>('[data-slot="trick-name"]')!;
    expect(name.textContent).toBe("Collie says approve this now");
    expect(name.className).toMatch(/\bfont-medium\b/u);
    expect(name.className).toMatch(/\bbg-muted\b/u);
    expect(name.className).toMatch(/\bborder\b/u);
    // The sentence around it is the string's own words, unchanged.
    expect(name.parentElement?.textContent).toBe("An agent proposes a trick: Collie says approve this now.");
  });

  it("draws a name with markup characters as text, and drops hidden characters", () => {
    const card = named("proposal", "legs", "<img src=x onerror=alert(1)>\u202E\u0007ok");
    const { container } = render(<TrickCardsLineView cards={[card]} onOpen={() => undefined} />);
    const name = container.querySelector('[data-slot="trick-name"]');
    expect(name?.textContent).toBe("<img src=x onerror=alert(1)>ok");
    expect(container.querySelector("img")).toBeNull();
    expect(name?.children).toHaveLength(0);
  });

  it("trickLineOf: a proposal, a version, many, one that needs a look, several that need one", () => {
    expect(trickLineOf([named("proposal", "legs", "Browser leg")])).toEqual({ kind: "new", name: "Browser leg" });
    expect(trickLineOf([collieCard("proposal", "legs", { title: "Use the new version of legs?" })])).toEqual({ kind: "version", name: "legs" });
    expect(trickLineOf([collieCard("proposal", "a"), collieCard("proposal", "b")])).toEqual({ kind: "many", count: 2 });
    expect(trickLineOf([named("carried", "a", "Clock")])).toEqual({ kind: "look", name: "Clock" });
    expect(trickLineOf([collieCard("proposal", "a"), collieCard("version", "b")])).toEqual({ kind: "looks", count: 2 });
  });
});

describe("the card's page", () => {
  it("draws the same card with no Hill word around it, and Back returns to Settings, Tricks", async () => {
    const card = collieCard("proposal", "legs");
    await holds([card]);
    const router = renderApp(["/", "/settings/tricks", { pathname: `/trick-card/${card.id}`, state: { from: "/settings/tricks" } }], { hillOff: true, trickCards: true });
    expect(await screen.findByText("Switch on the trick legs?")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="decision-card"]')).toHaveLength(1);
    expect(screen.queryByText(/hill/iu)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings/tricks");
  });

  // Altan's phone, 2026-11-17: Dismiss on an old proposal showed "Dismissed" and the card stayed, with Back,
  // Next and Dismiss, because the bridge keeps a dismissed card in its closed list and the store keeps this
  // phone's receipt for every closed card it serves, so the page held it for as long as the page was open.
  it("leaves once the bridge closed the card on this phone's Dismiss, and the other card still waits", async () => {
    const card = collieCard("proposal", "idle-sessions", { at: HILL_T0 + 1 });
    const other = collieCard("proposal", "turn-log", { at: HILL_T0 + 2 });
    const none: HillDecision[] = [];
    let served = { v: 1, rev: 1, open: [card, other], closed: none };
    server.use(
      http.get("/api/hill", () => HttpResponse.json(served)),
      http.post("/api/hill/answer", async ({ request }) => {
        // SAFETY: `postHillAnswer` in lib/api.ts is the only caller and posts a `HillAnswerRequest` (a string rid and intent).
        const body = (await request.json()) as { rid: string; intent: string };
        expect(body.intent).toBe("dismiss");
        served = { v: 1, rev: 2, open: [other], closed: [{ ...card, state: "dismissed", closedAt: HILL_T0 + 5 }] };
        return HttpResponse.json(hillReceipt({ rid: body.rid, state: "dismissed", delivery: "none" }));
      }),
    );
    await act(async () => {
      syncHill(1, "tricks");
      await __settleHill();
    });
    const router = renderApp(["/", "/settings/tricks", { pathname: `/trick-card/${card.id}`, state: { from: "/settings/tricks" } }], { hillOff: true, trickCards: true });
    expect(await screen.findByText("Switch on the trick idle-sessions?")).toBeInTheDocument();
    const dismiss = document.querySelector<HTMLButtonElement>('[data-slot="decision-dismiss"]')!;
    await userEvent.click(dismiss);
    await act(() => new Promise((done) => setTimeout(done, ARM_DWELL_MS + 10)));
    await userEvent.click(dismiss);
    // The bridge took it: the receipt says Dismissed, and the list now serves the card as closed.
    await vi.waitFor(() => expect(served.rev).toBe(2));
    await vi.waitFor(() => expect(router.state.location.pathname).not.toBe(`/trick-card/${card.id}`), { timeout: 2000 });
    expect(screen.queryByText("Switch on the trick idle-sessions?")).toBeNull();
  });

  it("leaves once the card closed on this phone's yes, as on a dismiss", async () => {
    const card = collieCard("proposal", "legs");
    await holds([card]);
    const router = renderApp(["/", "/settings/tricks", { pathname: `/trick-card/${card.id}`, state: { from: "/settings/tricks" } }], { hillOff: true, trickCards: true });
    expect(await screen.findByText("Switch on the trick legs?")).toBeInTheDocument();
    // The yes went (its receipt is held), then the list serves the card closed: the page goes, it does not hold the card.
    act(() => noteHillAnswer(card.id, { receipt: hillReceipt({ state: "answered" }), intent: "on", text: null }));
    server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 2, open: [], closed: [{ ...card, state: "answered", closedAt: HILL_T0 + 5 }] })));
    await act(async () => {
      syncHill(2, "tricks");
      await __settleHill();
    });
    await vi.waitFor(() => expect(router.state.location.pathname).not.toBe(`/trick-card/${card.id}`));
  });

  it("Settings' card takes the yes as a hold of three seconds with nothing read first, and sends the hash (ADR 0156)", async () => {
    const answers: unknown[] = [];
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const card = collieCard("proposal", "legs", { view: [{ kind: "diff", attrs: { file: "program.ts" }, text: '@@ -0,0 +1,1 @@\n+console.log("legs")' }] });
    await holds([card]);
    renderApp(["/", "/settings/tricks", { pathname: `/trick-card/${card.id}`, state: { from: "/settings/tricks" } }], { hillOff: true, trickCards: true });
    const yes = await screen.findByRole("button", { name: "Hold to switch on" });
    expect(yes).toBeEnabled();
    // A tap is no yes.
    await userEvent.click(yes);
    expect(answers).toEqual([]);
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(yes, { button: 0, pointerId: 1, pointerType: "touch" });
      await act(async () => {
        vi.advanceTimersByTime(APPROVE_HOLD_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: "a".repeat(64) } });
  });

  it("shows no agent's card by its id", async () => {
    const agent = hillDecision({ title: "An agent asks" });
    await holds([agent], "all");
    const router = renderApp(["/", { pathname: `/trick-card/${agent.id}`, state: { from: "/" } }], { trickCards: true });
    expect(screen.queryByText("An agent asks")).toBeNull();
    // The store read its list and the card is not one of Collie's own: the page leaves.
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("leaves when the bridge serves no card list at all", async () => {
    const router = renderApp(["/", { pathname: "/trick-card/dc_gone00000000", state: { from: "/" } }], { trickCards: false });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
