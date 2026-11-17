import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { isSessionProposal, SessionTrickCards } from "@/components/session-trick-card";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { collieCard, hillDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// PACKAGE I: a trick proposal shows in the chat view of the session that proposed it, as the card the Hill
// draws, and "Not now" there closes it in that session only (Settings, Tricks keeps it).

const SELF = "lodge/%3#abcd";

/** A proposal from the session at SELF: rights and warnings in its summary, its code in the view. */
function proposalCard(over: Partial<HillDecision> = {}): HillDecision {
  return collieCard("proposal", "legs", {
    replyTo: SELF,
    summary: "An agent session (repo#one) on lodge proposes it. It reaches the network. It runs a program.",
    view: [{ kind: "code", kids: [{ kind: "line", text: 'console.log("legs")' }] }],
    ...over,
  });
}

async function holds(open: HillDecision[]) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1, "tricks");
    await __settleHill();
  });
}

function renderChat(self: string) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ hillOff: true, trickCards: true }),
        element: withHeaderHost(<Outlet />),
        children: [
          {
            index: true,
            element: (
              <>
                <div data-testid="chat">
                  <SessionTrickCards self={self} />
                </div>
                <div data-testid="settings">
                  <TrickCardsWaiting />
                </div>
              </>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  __resetHill();
  forgetSessionLater();
});
afterEach(() => __resetHill());

describe("a trick proposal in its session's chat view", () => {
  it("draws the Hill's card in the session that proposed it: the rights and warnings, the code, Switch it on and Not now, no Dismiss", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    const card = await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    const slot = card.closest('[data-slot="session-trick-card"]');
    expect(slot).not.toBeNull();
    expect(slot).toHaveTextContent("It reaches the network. It runs a program.");
    expect(slot).toHaveTextContent('console.log("legs")');
    const on = screen.getByRole("button", { name: /Switch it on/u });
    // Nothing is focused or recommended (the yes's wait for the end of the code is decision-card's own test).
    expect(document.activeElement).not.toBe(on);
    expect(slot?.querySelector('[data-slot="decision-recommended-mark"]')).toBeNull();
    expect(screen.getByRole("button", { name: /Not now/u })).toBeInTheDocument();
    expect(slot?.querySelector('[data-slot="decision-dismiss"]')).toBeNull();
  });

  it("shows nothing in another session, and never an agent's own Decision", async () => {
    await holds([proposalCard(), hillDecision({ title: "An agent asks", replyTo: SELF })]);
    renderChat("lodge/%9#ffff");
    expect(await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=settings] *" })).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeEmptyDOMElement();
    expect(isSessionProposal(hillDecision({ replyTo: SELF }), SELF)).toBe(false);
    expect(isSessionProposal(collieCard("version", "legs", { replyTo: SELF }), SELF)).toBe(false);
    // The instance token does not matter: the pane is the same.
    expect(isSessionProposal(proposalCard(), "lodge/%3")).toBe(true);
  });

  it("Not now closes the card in the session, sends nothing, and Settings, Tricks keeps it waiting for a yes", async () => {
    const answers: unknown[] = [];
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await userEvent.click(screen.getByRole("button", { name: /Not now/u }));
    expect(screen.getByTestId("chat")).toBeEmptyDOMElement();
    expect(answers).toEqual([]);
    expect(screen.getByRole("heading", { name: "Waiting for your yes" })).toBeInTheDocument();
    expect(screen.getByTestId("settings")).toHaveTextContent("Switch on the trick legs?");
  });
});
