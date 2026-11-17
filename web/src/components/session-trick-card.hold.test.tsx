import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentViewScreen } from "@/components/agent-view-screen";
import { ChatApprovalCard } from "@/components/session-trick-card";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";

// THE CHAT CARD'S YES IS A HOLD OF THREE SECONDS (ADR 0156), in the chat's own scroll and in an agent view's own
// scroll, where the card stands while the view stands in for the chat. The fold is never opened in these cases:
// reading is offered, not required. A scroll of the box the card flows in, while a finger holds the yes, ends the
// hold; the decline stays one tap.

const HASH = "a".repeat(64);
const decision: HillDecision = collieCard("proposal", "legs", {
  replyTo: "lodge/%3#abcd",
  view: [
    { kind: "para", text: "It runs as you." },
    { kind: "diff", attrs: { file: "program.ts" }, text: "@@ -0,0 +1,1 @@\n+console.log(1);" },
  ],
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Where the card stands: last in the chat's thread, or last in an agent view's own scroll. */
type Host = "chat" | "agent-view";

function draw(host: Host, shown: HillDecision = decision) {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  const onLater = vi.fn();
  const card = <ChatApprovalCard decision={shown} answer={HILL_IDLE} onSend={onSend} onLater={onLater} />;
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
  const option = (intent: string) => view.container.querySelector<HTMLButtonElement>(`[data-slot="chat-approval-option"][data-intent="${intent}"]`);
  const toggle = () => view.container.querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!;
  return { onSend, onLater, box, yes: () => option("on"), no: () => option("later")!, toggle };
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const down = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, pointerId: 1, pointerType: "touch" });
const up = (el: HTMLElement) => {
  fireEvent.pointerUp(el, { button: 0, pointerId: 1, pointerType: "touch" });
  fireEvent.click(el, { detail: 1 });
};

describe.each(["chat", "agent-view"] as const)("the card's yes, in the %s's scroll", (host) => {
  it("is ready at the draw with the fold never opened, and a hold of three seconds sends once with the hash", () => {
    const { onSend, yes, toggle } = draw(host);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(yes()).toBeEnabled();
    expect(yes()).toHaveTextContent("Hold to switch on");
    down(yes()!);
    wait(APPROVE_HOLD_MS - 1);
    expect(onSend).not.toHaveBeenCalled();
    wait(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("on", null, { digest: HASH });
    up(yes()!);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("a lift at 2.9 seconds sends nothing; a tap sends nothing", () => {
    const { onSend, yes } = draw(host);
    down(yes()!);
    up(yes()!);
    down(yes()!);
    wait(2900);
    up(yes()!);
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a scroll of the box the card flows in, while the finger holds, ends the hold", () => {
    const { onSend, yes, box } = draw(host);
    down(yes()!);
    wait(1500);
    fireEvent.scroll(box);
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a key presses twice", () => {
    const { onSend, yes } = draw(host);
    fireEvent.click(yes()!, { detail: 0 });
    expect(yes()).toHaveTextContent("Press again to confirm");
    wait(500);
    fireEvent.click(yes()!, { detail: 0 });
    expect(onSend).toHaveBeenCalledWith("on", null, { digest: HASH });
  });

  it("Not now stays one tap and sends nothing", () => {
    const { onSend, onLater, no } = draw(host);
    fireEvent.click(no(), { detail: 1 });
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a card that cannot show its code whole has no yes, held or tapped", () => {
    // SAFETY: the node kind is unknown on purpose, as a newer bridge would send it; the renderer draws its placeholder.
    const unknown = { ...decision, view: [{ kind: "para", text: "It runs as you." }, { kind: "hologram", text: "a right" } as never, { kind: "diff", attrs: { file: "a.ts" }, text: "+1" }] } satisfies HillDecision;
    const { yes, no } = draw(host, unknown);
    expect(yes()).toBeNull();
    expect(no()).toBeEnabled();
  });
});
