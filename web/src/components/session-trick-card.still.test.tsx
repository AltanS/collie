import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentViewScreen } from "@/components/agent-view-screen";
import { ChatApprovalCard } from "@/components/session-trick-card";
import { COLLAPSE_MS } from "@/components/ui/collapse";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { STILL_MS, STILL_TICK_MS } from "@/hooks/use-still";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";
import { stubAllSeen } from "@/test/seen-end";

// THE CHAT CARD'S YES WAITS FOR THE CARD TO STAND STILL (security read of package I, point 2), measured in the
// chat's own scroll (2026-11-17): the card flows in the thread like a message, so the person scrolling to read
// is not a move and does not keep the yes off for ever; a row put in above the card is, and waits again. A touch
// that began before the yes was ready is not a tap on it. The same in an agent view's own scroll, where the card
// stands while the view stands in for the chat.

const HASH = "a".repeat(64);
const decision: HillDecision = collieCard("proposal", "legs", {
  replyTo: "lodge/%3#abcd",
  view: [
    { kind: "para", text: "It runs as you." },
    { kind: "diff", attrs: { file: "program.ts" }, text: "@@ -0,0 +1,1 @@\n+console.log(1);" },
  ],
});

/** Where the card is on the screen, and how far the chat is scrolled. */
let cardTop = 500;
let scroll = 0;

beforeEach(() => {
  vi.useFakeTimers();
  cardTop = 500;
  scroll = 0;
  // The opened marks of a card live in sessionStorage (lib/hill/group-opened.ts): each case starts unread.
  sessionStorage.clear();
  stubAllSeen();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "chat" || this.hasAttribute("data-scroll-root")) return new DOMRect(0, 0, 390, 800);
    // The card grows while its fold is open, as it does on a phone.
    return new DOMRect(0, cardTop, 360, this.querySelector('[data-slot="chat-approval-code"]') === null ? 240 : 640);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Where the card stands: last in the chat's thread, or last in an agent view's own scroll. */
type Host = "chat" | "agent-view";

function draw(host: Host = "chat") {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  const card = <ChatApprovalCard decision={decision} answer={HILL_IDLE} onSend={onSend} onLater={vi.fn()} />;
  const view = render(
    host === "chat" ? (
      <div data-testid="chat" style={{ overflowY: "auto" }}>
        {card}
      </div>
    ) : (
      <AgentViewScreen name="Morph" session="lodge/%3#abcd" view={undefined} working={false} entries={[]} canAct onTap={vi.fn()} onLink={vi.fn()} now={Date.parse("2026-11-17T10:00:00.000Z")} settleMs={0} tail={card} />
    ),
  );
  const box = host === "chat" ? view.getByTestId("chat") : view.container.querySelector<HTMLElement>("[data-scroll-root]")!;
  Object.defineProperty(box, "scrollTop", { configurable: true, get: () => scroll });
  const option = (intent: string) => view.container.querySelector<HTMLButtonElement>(`[data-slot="chat-approval-option"][data-intent="${intent}"]`)!;
  const toggle = () => view.container.querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!;
  return { onSend, yes: () => option("on"), no: () => option("later"), toggle };
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** Opens the fold and lets it settle: its end mark is drawn and (stubbed) seen. */
function readCode(toggle: () => HTMLButtonElement) {
  fireEvent.click(toggle(), { detail: 1 });
  wait(COLLAPSE_MS + 64);
}

describe.each(["chat", "agent-view"] as const)("the card's yes, in the %s's scroll", (host) => {
  it("is off until the code was read AND the card stood still for a second; the decline is never held", () => {
    const { yes, no, toggle } = draw(host);
    wait(STILL_MS * 2);
    // Still for two seconds, but the code is not read: off.
    expect(yes()).toBeDisabled();
    expect(no()).toBeEnabled();
    readCode(toggle);
    // The fold opening changed the card's size: a new second of standing still.
    expect(yes()).toBeDisabled();
    wait(STILL_MS + STILL_TICK_MS * 2);
    expect(yes()).toBeEnabled();
  });

  it("a press that began before the yes was ready sends nothing; a press on the ready yes sends once with the hash", () => {
    const { onSend, yes, toggle } = draw(host);
    readCode(toggle);
    fireEvent.pointerDown(yes());
    wait(STILL_MS + STILL_TICK_MS * 2);
    expect(yes()).toBeEnabled();
    fireEvent.click(yes(), { detail: 1 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.pointerDown(yes());
    fireEvent.click(yes(), { detail: 1 });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("on", null, { digest: HASH, opened: [1] });
  });

  it("scrolling the chat to read moves the card on the screen but not in the thread: the yes is not kept off", () => {
    const { yes, toggle } = draw(host);
    readCode(toggle);
    // The person scrolls down through the code for three seconds, a step every tick.
    for (let i = 0; i < 30; i++) {
      cardTop -= 10;
      scroll += 10;
      wait(STILL_TICK_MS);
    }
    expect(yes()).toBeEnabled();
    // And it stays on while they go on scrolling.
    cardTop -= 50;
    scroll += 50;
    wait(STILL_TICK_MS);
    expect(yes()).toBeEnabled();
  });

  it("a row put in above the card shifts it in the thread: the yes is off again for a whole second", () => {
    const { yes, toggle } = draw(host);
    readCode(toggle);
    wait(STILL_MS + STILL_TICK_MS * 2);
    expect(yes()).toBeEnabled();
    // A new message lands above the card: it moves down with no scroll by the person.
    cardTop += 64;
    wait(STILL_TICK_MS);
    expect(yes()).toBeDisabled();
    wait(STILL_MS - STILL_TICK_MS * 2);
    expect(yes()).toBeDisabled();
    wait(STILL_TICK_MS * 3);
    expect(yes()).toBeEnabled();
  });
});
