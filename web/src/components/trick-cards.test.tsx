import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, type InitialEntry } from "react-router";

import { firstSentence, TrickCardsLine, TrickCardsWaiting, TrickCardsWaitingList } from "@/components/trick-cards";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { TrickCardRoute } from "@/routes/trick-card";
import { withHeaderHost } from "@/test/header-host";
import { collieCard, HILL_T0, hillDecision } from "@/test/hill-fixtures";
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

describe("the Dashboard's line", () => {
  it("shows with the Hill off while a card waits, and opens the oldest", async () => {
    const newer = collieCard("version", "legs", { at: HILL_T0 + 2 });
    const older = collieCard("proposal", "git", { at: HILL_T0 + 1 });
    await holds([newer, older]);
    const router = renderApp(["/"], { hillOff: true, trickCards: true });
    expect(await screen.findByText("A trick waits for your yes.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read it" }));
    expect(router.state.location.pathname).toBe(`/trick-card/${older.id}`);
  });

  it("is not drawn with the Hill on: the bar's Hill item is the signal", async () => {
    await holds([collieCard("proposal", "legs")], "all");
    renderApp(["/"], { trickCards: true });
    await screen.findByTestId("home");
    expect(screen.queryByText("A trick waits for your yes.")).toBeNull();
  });

  it("is not drawn while no card waits", async () => {
    renderApp(["/"], { hillOff: true, trickCards: false });
    await screen.findByTestId("home");
    expect(document.querySelector('[data-slot="trick-waits"]')).toBeNull();
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
