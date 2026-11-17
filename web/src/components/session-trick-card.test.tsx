import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { isSessionProposal, SessionTrickCards } from "@/components/session-trick-card";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { postHillAnswer } from "@/lib/api";
import { forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { collieCard, hillDecision } from "@/test/hill-fixtures";
import { stubAllSeen } from "@/test/seen-end";
import { server } from "@/test/setup";

// The card standing still for a second is tested in decision-card.still.test.tsx; here every card has.
vi.mock("@/hooks/use-still", () => ({ STILL_MS: 1000, STILL_TICK_MS: 100, useStill: (el: HTMLElement | null) => el !== null }));

// PACKAGE I: a trick proposal shows in the chat view of the session that proposed it, as the card the Hill
// draws, and "Not now" there closes it in that session only (Settings, Tricks keeps it).

const SELF = "lodge/%3#abcd";

/** A proposal from the session at SELF: rights and warnings in its summary, its code in the view. */
function proposalCard(over: Partial<HillDecision> = {}): HillDecision {
  return collieCard("proposal", "legs", {
    replyTo: SELF,
    summary: "A session on lodge proposes it. It reaches the network. It runs a program.",
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
  stubAllSeen();
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
  vi.unstubAllGlobals();
});

const slotOf = (id: string) => document.querySelector<HTMLElement>(`[data-slot="session-trick-card"][data-card="${id}"]`);

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

  it("Switch it on waits until the code was on screen to its end, then ONE tap sends the answer once", async () => {
    // A code view taller than the screen: its end mark must come on screen before the yes is active.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20_000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, window.innerHeight * 3));
    type Seen = (entries: readonly { isIntersecting: boolean }[]) => void;
    const seen: { callback: Seen; target: Element | null; root: Element | null }[] = [];
    class FakeObserver {
      private readonly at: { callback: Seen; target: Element | null; root: Element | null };
      constructor(callback: Seen, options?: { root?: Element | null }) {
        this.at = { callback, target: null, root: options?.root ?? null };
        seen.push(this.at);
      }
      observe(target: Element): void {
        this.at.target = target;
      }
      disconnect(): void {
        this.at.target = null;
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    const answers: unknown[] = [];
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const card = proposalCard({ options: [{ intent: "on", label: "Switch it on" }, { intent: "later", label: "Not now" }] });
    await holds([card]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    const on = screen.getByRole("button", { name: /Switch it on/u });
    // Before the code was seen the yes is not active, and a tap sends nothing.
    expect(on).toBeDisabled();
    await userEvent.click(on);
    expect(answers).toEqual([]);
    // The end mark is watched with the card's scroll box (60dvh) as the observer's root.
    const watching = seen.filter((o) => o.target !== null);
    expect(watching).toHaveLength(1);
    expect(watching[0]!.root).toBe(slotOf(card.id));
    // The end of the code comes on screen: now one tap answers, with no second confirming tap.
    act(() => {
      for (const one of seen.filter((o) => o.target !== null)) one.callback([{ isIntersecting: true }]);
    });
    expect(screen.getByRole("button", { name: /Switch it on/u })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Switch it on/u }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on" });
  });

  it("shows nothing in another session, and never an agent's own Decision", async () => {
    await holds([proposalCard(), hillDecision({ title: "An agent asks", replyTo: SELF })]);
    renderChat("lodge/%9#ffff");
    expect(await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=settings] *" })).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeEmptyDOMElement();
    expect(isSessionProposal(hillDecision({ replyTo: SELF }), SELF)).toBe(false);
    expect(isSessionProposal(collieCard("version", "legs", { replyTo: SELF }), SELF)).toBe(false);
  });

  it("compares the FULL address: a new session in the same pane, with another instance token, never shows an old card (security read, point 3)", async () => {
    expect(isSessionProposal(proposalCard(), SELF)).toBe(true);
    expect(isSessionProposal(proposalCard(), "lodge/%3#ffff")).toBe(false);
    // The pane address alone, with no token, is not the session either.
    expect(isSessionProposal(proposalCard(), "lodge/%3")).toBe(false);
    await holds([proposalCard()]);
    renderChat("lodge/%3#ffff");
    expect(await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=settings] *" })).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeEmptyDOMElement();
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

  it("a crew member's pane: the member's own snapshot carries no hill, so the chat shows no card, and a refused yes would say why (security read, point 6)", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    // The chat of a member's pane reads that member's snapshot: no `hillRev`, so the store is emptied.
    act(() => syncHill(undefined, "tricks"));
    await waitFor(() => expect(screen.getByTestId("chat")).toBeEmptyDOMElement());
    // A yes that still reached a member-scoped answer route is refused with the bridge's sentence, never silently.
    server.use(http.post("/api/hill/answer", () => new HttpResponse("the hill reads this machine only for now; ask the machine itself", { status: 400 })));
    const receipt = await postHillAnswer({ rid: "7c2a7a3e-6a42-4f5e-9d2b-3a0a6e7a1b11", node: "hill/dc_test0000001", intent: "on", value: { text: null } });
    expect(receipt.code).toBe("rejected");
    expect(receipt.reason).toBe("the hill reads this machine only for now; ask the machine itself");
  });
});
