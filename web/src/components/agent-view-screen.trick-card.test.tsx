import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { AgentViewScreen, type AgentViewScreenProps } from "@/components/agent-view-screen";
import { SessionTrickCards } from "@/components/session-trick-card";
import { TailRoomContext } from "@/components/ui/chat/chat-message-list";
import { forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";
import { stubAllSeen } from "@/test/seen-end";
import { server } from "@/test/setup";

// The card standing still for a second is tested in session-trick-card.still.test.tsx, in this view too.
vi.mock("@/hooks/use-still", () => ({ STILL_MS: 1000, STILL_TICK_MS: 100, useStill: (el: HTMLElement | null) => el !== null }));

// A TRICK PROPOSAL WHILE AN AGENT VIEW STANDS IN FOR THE CHAT (2026-11-17): the same card, last in the view's own
// scroll, with the same guards. A card never needs a trip to Settings.

const SELF = "lodge/%3#abcd";
const HASH = "a".repeat(64);

function proposalCard(): HillDecision {
  return collieCard("proposal", "legs", {
    replyTo: SELF,
    summary: "A session on lodge proposes it. It has 1 file.",
    view: [
      { kind: "para", text: "It runs as you: it can read and change any file you can." },
      { kind: "diff", attrs: { file: "program.ts" }, text: '@@ -0,0 +1,1 @@\n+console.log("legs")' },
    ],
  });
}

async function holds(open: HillDecision[]) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1, "tricks");
    await __settleHill();
  });
}

/** An agent view (Morph) with the session's proposals at its tail, under a model tag that takes 40 px. */
function drawView(self: string) {
  const props: AgentViewScreenProps = {
    name: "Morph",
    session: SELF,
    view: undefined,
    working: false,
    entries: [],
    canAct: true,
    onTap: vi.fn(),
    onLink: vi.fn(),
    now: Date.parse("2026-11-17T10:00:00.000Z"),
    settleMs: 0,
    tail: <SessionTrickCards self={self} />,
  };
  render(
    <TailRoomContext.Provider value={40}>
      <AgentViewScreen {...props} />
    </TailRoomContext.Provider>,
  );
}

const viewEl = () => document.querySelector<HTMLElement>('[data-slot="agent-view"]')!;
/** The view's own scroller: the box the card flows in. */
const scroller = () => viewEl().querySelector<HTMLElement>(".overflow-y-auto")!;

type Seen = (entries: readonly { isIntersecting: boolean }[]) => void;
interface Watch {
  callback: Seen;
  target: Element | null;
  root: Element | null;
  margin: string | undefined;
}

beforeEach(() => {
  stubAllSeen();
  // Boxes on screen: the scroller the card flows in fills the phone, every other box sits well inside it, above
  // its tail room. A mark the observer reports is looked at again against these (inView).
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-scroll-root") ? new DOMRect(0, 0, 390, 700) : new DOMRect(0, 100, 360, 20);
  });
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a trick proposal while an agent view stands in for the chat", () => {
  it("shows the same card last in the view's own scroll, and only in the session that proposed it", async () => {
    await holds([proposalCard()]);
    drawView(SELF);
    await screen.findByText("Switch on the trick legs?");
    const card = viewEl().querySelector('[data-slot="chat-approval"]');
    expect(card).not.toBeNull();
    // Inside the view's scroller, after the screen: no band, no box of its own.
    expect(scroller().contains(card)).toBe(true);
    expect(scroller().lastElementChild?.contains(card)).toBe(true);
    expect(card).toHaveTextContent("It runs as you: it can read and change any file you can.");
    expect(within(viewEl()).getByRole("button", { name: /Not now/u })).toBeEnabled();
  });

  it("another session's view (another instance token) shows no card", async () => {
    await holds([proposalCard()]);
    drawView("lodge/%3#ffff");
    await act(async () => {
      await __settleHill();
    });
    expect(viewEl().querySelector('[data-slot="chat-approval"]')).toBeNull();
  });

  it("the guards hold with the view's scroller as root: a closed fold never counts, the end is watched less the tail room, one tap sends once with the hash", async () => {
    const seen: Watch[] = [];
    class FakeObserver {
      private readonly at: Watch;
      constructor(callback: Seen, options?: { root?: Element | null; rootMargin?: string }) {
        this.at = { callback, target: null, root: options?.root ?? null, margin: options?.rootMargin };
        seen.push(this.at);
      }
      observe(target: Element): void {
        this.at.target = target;
      }
      disconnect(): void {
        this.at.target = null;
      }
      unobserve(): void {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const answers: unknown[] = [];
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const showEveryEnd = () =>
      act(() => {
        for (const one of seen.filter((o) => o.target !== null)) one.callback([{ isIntersecting: true }]);
      });
    await holds([proposalCard()]);
    drawView(SELF);
    await screen.findByText("Switch on the trick legs?");
    const yes = () => within(viewEl()).getByRole("button", { name: /Switch it on/u });
    expect(yes()).toBeDisabled();
    // With the fold closed there is no mark of the code to see.
    showEveryEnd();
    expect(yes()).toBeDisabled();
    await userEvent.click(yes());
    expect(answers).toEqual([]);
    await userEvent.click(viewEl().querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!);
    await waitFor(() => expect(viewEl().querySelector('[data-slot="chat-approval-section"] [data-slot="chat-approval-end"]')).not.toBeNull());
    expect(yes()).toBeDisabled();
    const watching = seen.filter((o) => o.target !== null);
    expect(watching).toHaveLength(1);
    expect(watching[0]!.root).toBe(scroller());
    expect(watching[0]!.margin).toBe("0px 0px -40px 0px");
    showEveryEnd();
    expect(yes()).toBeEnabled();
    await userEvent.click(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: HASH, opened: [1] } });
  });

  it("a mark under a floating card that came later does not count in the view either; above the tail room it does", async () => {
    const seen: { callback: Seen; target: Element | null }[] = [];
    class FakeObserver {
      private readonly at: { callback: Seen; target: Element | null };
      constructor(callback: Seen) {
        this.at = { callback, target: null };
        seen.push(this.at);
      }
      observe(target: Element): void {
        this.at.target = target;
      }
      disconnect(): void {
        this.at.target = null;
      }
      unobserve(): void {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    await holds([proposalCard()]);
    drawView(SELF);
    await screen.findByText("Switch on the trick legs?");
    const yes = () => within(viewEl()).getByRole("button", { name: /Switch it on/u });
    await userEvent.click(viewEl().querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!);
    await waitFor(() => expect(viewEl().querySelector('[data-slot="chat-approval-section"] [data-slot="chat-approval-end"]')).not.toBeNull());
    scroller().style.setProperty("--tail-room", "650px");
    act(() => {
      for (const one of seen.filter((o) => o.target !== null)) one.callback([{ isIntersecting: true }]);
    });
    expect(yes()).toBeDisabled();
    scroller().style.setProperty("--tail-room", "0px");
    act(() => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(yes()).toBeEnabled());
  });
});
