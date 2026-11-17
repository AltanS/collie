import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatApprovalCard } from "@/components/session-trick-card";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";

// THE HOLD IN A LIVE CHAT (fix/hold-works, 2026-11-17). On Altan's Android phone the chat card's "Hold to switch on"
// kept resetting its fill. The card stands last in the chat's own scroller (components/ui/chat/chat-message-list.tsx),
// which follows its tail: every poll that brings a line moves `dep` and `useAutoScroll` pins the list to the bottom
// with `scrollTo` (hooks/use-auto-scroll.ts `pinToBottom`). A real browser fires `scroll` for that move, and the hold
// took every scroll on the page as the person's own. Here the scroller is the real one and the card the real one; only
// the browser's layout is modelled: the content grows by one row per line, and `scrollTo` moves `scrollTop` and fires
// `scroll` when the place changed, as a browser does.

const decision: HillDecision = collieCard("proposal", "legs", {
  replyTo: "lodge/%3#abcd",
  view: [
    { kind: "para", text: "It runs as you." },
    { kind: "diff", attrs: { file: "program.ts" }, text: "@@ -0,0 +1,1 @@\n+console.log(1);" },
  ],
});

const ROW_PX = 40;
const VIEW_PX = 400;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no `scrollTo` on an element; the first pin at mount lands here, before the layout below takes over.
  // SAFETY: a widening to a partial record only, so the presence check reads as jsdom's truth, not the DOM types'.
  const proto = HTMLElement.prototype as Partial<Pick<HTMLElement, "scrollTo">>;
  if (proto.scrollTo === undefined) proto.scrollTo = () => {};
});
afterEach(() => {
  vi.useRealTimers();
});

/** The scroller's layout, as a browser would give it: one row per line, and a scroll event for every move. */
function layOut(scroller: HTMLElement, rows: () => number) {
  let top = 0;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEW_PX });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => rows() * ROW_PX + 300 });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  const moves: number[] = [];
  // SAFETY: the list calls `scrollTo` only with an options object (hooks/use-auto-scroll.ts), the one overload modelled here.
  scroller.scrollTo = ((options: ScrollToOptions) => {
    const max = Math.max(0, scroller.scrollHeight - VIEW_PX);
    const next = Math.min(max, Math.max(0, options.top ?? top));
    if (next === top) return;
    top = next;
    moves.push(next);
    scroller.dispatchEvent(new Event("scroll"));
  }) as typeof scroller.scrollTo;
  return { moves, top: () => top };
}

/** A session's chat: lines that polls bring, and the trick's card last, in the real chat scroller. */
function Chat({ lines, rev, answer = HILL_IDLE, onSend }: { lines: number; rev: number; answer?: HillAnswerState; onSend: (intent: string, text: string | null, group?: HillGroupAnswer) => void }) {
  const [later] = useState(() => vi.fn());
  return (
    <ChatMessageList dep={rev} data-slot="session-stream">
      {Array.from({ length: lines }, (_, i) => (
        <p key={i}>line {i}</p>
      ))}
      <ChatApprovalCard decision={decision} answer={answer} onSend={onSend} onLater={later} />
    </ChatMessageList>
  );
}

function draw() {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  let lines = 5;
  const view = render(<Chat lines={lines} rev={0} onSend={onSend} />);
  const scroller = view.container.querySelector<HTMLElement>('[data-slot="session-stream"]')!;
  const layout = layOut(scroller, () => lines);
  /** A poll: `more` new lines (0 is a poll that brought nothing new, a re-render only). */
  const poll = (more: number, rev: number, answer?: HillAnswerState) => {
    lines += more;
    view.rerender(<Chat lines={lines} rev={rev} answer={answer} onSend={onSend} />);
  };
  const yes = () => view.container.querySelector<HTMLButtonElement>('[data-slot="chat-approval-option"][data-intent="on"]')!;
  return { onSend, poll, yes, layout, scroller };
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const down = (el: HTMLElement, id = 1) => fireEvent.pointerDown(el, { button: 0, pointerId: id, clientX: 20, clientY: 20, pointerType: "touch" });

describe("the hold in a live chat", () => {
  it("polls that bring nothing new, during a hold, leave it alone", async () => {
    const { onSend, poll, yes } = draw();
    down(yes());
    for (let i = 1; i <= 5; i++) {
      await wait(200);
      poll(0, 0);
    }
    await wait(APPROVE_HOLD_MS - 1000);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("lines that arrive during a hold do not reset it, and the chat does not follow while a finger holds", async () => {
    const { onSend, poll, yes, layout } = draw();
    down(yes());
    const before = layout.moves.length;
    for (let rev = 1; rev <= 5; rev++) {
      await wait(200);
      poll(1, rev);
      expect(yes().getAttribute("data-phase")).not.toBe("rest");
    }
    // While the finger holds, the list did not jump the card away to follow the tail.
    expect(layout.moves.length).toBe(before);
    await wait(APPROVE_HOLD_MS - 1000);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("on");
  });

  it("after the hold the chat follows its tail again", async () => {
    const { poll, yes, layout } = draw();
    down(yes());
    await wait(1000);
    poll(1, 1);
    fireEvent.pointerUp(yes(), { button: 0, pointerId: 1, pointerType: "touch" });
    const before = layout.moves.length;
    poll(1, 2);
    expect(layout.moves.length).toBeGreaterThan(before);
  });

  it("the person's own scroll of the chat, with no finger on the yes, is still a scroll", async () => {
    const { onSend, yes, scroller } = draw();
    down(yes());
    await wait(1000);
    scroller.dispatchEvent(new Event("scroll"));
    await wait(APPROVE_HOLD_MS);
    // A scroll alone no longer ends a hold: the browser's pan of a touch that began on the yes ends it with
    // `pointercancel`, and `touch-action: none` on the button keeps a still finger from becoming a pan at all.
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a hold that finishes while a yes is in flight sends nothing", async () => {
    const { onSend, poll, yes } = draw();
    down(yes());
    await wait(1000);
    // Another press elsewhere (a key's two presses, another device's receipt arriving) put a yes in flight.
    poll(0, 0, { phase: "sending", intent: "on", text: null });
    await wait(APPROVE_HOLD_MS);
    expect(onSend).not.toHaveBeenCalled();
  });
});
