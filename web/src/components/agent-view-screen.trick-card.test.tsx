import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { AgentViewScreen, type AgentViewScreenProps } from "@/components/agent-view-screen";
import { SessionTrickCards } from "@/components/session-trick-card";
import { TailRoomContext } from "@/components/ui/chat/chat-message-list";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import { forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// Every way a hold ends early is tested on the control (hold-to-approve.test.tsx) and in this view's scroll too
// (session-trick-card.hold.test.tsx).

// A TRICK PROPOSAL WHILE AN AGENT VIEW STANDS IN FOR THE CHAT (2026-11-17): the same card, last in the view's own
// scroll, with the same yes: a hold of 1.5 seconds (ADR 0156). A card never needs a trip to Settings.

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

beforeEach(() => {
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
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

  it("the yes is a hold: ready with the fold never opened, and 1.5 seconds send once with the hash", async () => {
    const answers: unknown[] = [];
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        answers.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    await holds([proposalCard()]);
    drawView(SELF);
    await screen.findByText("Switch on the trick legs?");
    const yes = within(viewEl()).getByRole("button", { name: /Hold to switch on/u });
    expect(yes).toBeEnabled();
    expect(viewEl().querySelector('[data-slot="chat-approval-code-toggle"]')).toHaveAttribute("aria-expanded", "false");
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
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: HASH, opened: [1] } });
  });
});
