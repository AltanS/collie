import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DecisionCard } from "@/components/decision-card";
import { ChatApprovalCard } from "@/components/session-trick-card";
import { trickLineWords } from "@/components/trick-approval-line";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import type { HillDecision } from "@/lib/hill/wire";
import { collieCard, hillDecision } from "@/test/hill-fixtures";

// AN ANSWERED TRICK APPROVAL IS ONE LINE (Altan, 2026-11-18), AND AN OPEN ONE NEVER TRAPS THE SCROLL. The line: the tricks
// glyph on its 16px tile, "Collie tricks", the trick's name and what happened to it. The scroll: a swipe that starts on
// the open card is the browser's, so nothing in the card calls preventDefault on a move or sets `touch-action: none`.

const SELF = "lodge/%3#abcd";

/** A new trick's proposal from the session at SELF. */
function proposal(over: Partial<HillDecision> = {}): HillDecision {
  return collieCard("proposal", "hadoken", {
    replyTo: SELF,
    view: [
      { kind: "para", text: "It runs as you." },
      { kind: "diff", attrs: { file: "program.ts" }, text: "@@ -0,0 +1,1 @@\n+console.log(1);" },
    ],
    ...over,
  });
}

/** A new version of a trick: the bridge posts it as a proposal whose yes reads "Use the new version". */
function version(): HillDecision {
  return proposal({
    title: "Use the new version of hadoken?",
    options: [
      { intent: "on", label: "Use the new version" },
      { intent: "later", label: "Keep the old version" },
    ],
  });
}

const ok = (intent: string): HillAnswerState => ({
  phase: "answered",
  intent,
  text: null,
  receipt: { rid: "r", code: "ok", reason: null, state: "answered", delivery: "typed", trick: null, at: 0 },
});

function draw(decision: HillDecision, answer: HillAnswerState) {
  return render(<ChatApprovalCard decision={decision} answer={answer} onSend={vi.fn()} onLater={vi.fn()} />);
}

describe("an answered trick approval collapses into one line", () => {
  it.each([
    ["a new trick, switched on", proposal(), "on", "hadoken: switched on", "approved"],
    ["a new trick, declined", proposal(), "later", "hadoken: not switched on", "declined"],
    ["a new version, in use", version(), "on", "hadoken: new version in use", "approved"],
    ["a new version, kept the old one", version(), "later", "hadoken: kept the old version", "declined"],
    ["a dismiss", proposal(), "dismiss", "hadoken: not switched on", "declined"],
  ])("%s", (_, decision, intent, words, outcome) => {
    const { container } = draw(decision, ok(intent));
    const line = container.querySelector<HTMLElement>('[data-slot="chat-approval-line"]')!;
    expect(line).not.toBeNull();
    expect(line.dataset.outcome).toBe(outcome);
    // The glyph on its 16px tile, the label, the name and the outcome.
    expect(line.querySelector('[data-slot="decision-trick-mark"]')).not.toBeNull();
    expect(line.querySelector('[data-slot="decision-trick-mark"]')!.className).toContain("size-4");
    expect(line).toHaveTextContent("Collie tricks");
    expect(line).toHaveTextContent(words);
    // It is a line: no card, no panel, no button, no hold.
    expect(container.querySelector('[data-slot="chat-approval"]')).toBeNull();
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-slot="chat-approval-title"]')).toBeNull();
  });

  it("a card dismissed on another device collapses to the declined line", () => {
    const { container } = draw({ ...proposal(), state: "dismissed" }, HILL_IDLE);
    expect(container.querySelector('[data-slot="chat-approval-line"]')).toHaveTextContent("hadoken: not switched on");
  });

  it("names the trick by its display name, else by its id", () => {
    const named = proposal();
    expect(trickLineWords({ ...named, from: { ...named.from, name: "Hadoken Fireball" } }, true)).toBe("Hadoken Fireball: switched on");
    expect(trickLineWords(named, true)).toBe("hadoken: switched on");
  });

  it("an answer that did not land, or is in flight, is still the card", () => {
    const sending: HillAnswerState = { phase: "sending", intent: "on", text: null };
    const failed: HillAnswerState = { phase: "failed", intent: "on", text: null };
    const refused: HillAnswerState = { phase: "answered", intent: "on", text: null, receipt: { rid: "r", code: "rejected", reason: "changed", state: "open", delivery: null, trick: null, at: 0 } };
    for (const answer of [HILL_IDLE, sending, failed, refused]) {
      const { container, unmount } = draw(proposal(), answer);
      expect(container.querySelector('[data-slot="chat-approval"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="chat-approval-line"]')).toBeNull();
      unmount();
    }
  });

  it("only a trick approval collapses: the Hill's card for another Decision keeps its card and its options after an answer", () => {
    const other = hillDecision();
    const { container } = render(<DecisionCard decision={other} answer={ok("yes")} onSend={vi.fn()} />);
    expect(container.querySelector('[data-slot="decision-card"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="chat-approval-line"]')).toBeNull();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(1);
  });
});

describe("an open trick approval never traps a swipe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("nothing in the card sets touch-action none or stops a vertical pan from chaining to the chat", () => {
    const { container } = draw(proposal(), HILL_IDLE);
    const card = container.querySelector<HTMLElement>('[data-slot="chat-approval"]')!;
    for (const el of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls, el.outerHTML.slice(0, 80)).not.toMatch(/(^|\s)touch-none(\s|$)|\[touch-action:none\]/u);
      expect(el.style.touchAction, el.outerHTML.slice(0, 80)).not.toBe("none");
      // A box that scrolls vertically on its own must hand the end of its scroll to the chat.
      if (/(^|\s)overflow-y-(auto|scroll)(\s|$)/u.test(cls)) expect(cls).not.toMatch(/overscroll-(y-)?contain|overscroll-(y-)?none/u);
    }
    // The hold button keeps the vertical pan for the browser: a sideways drift is no pan, a vertical swipe scrolls the chat.
    expect(card.querySelector('[data-intent="on"]')!.className).toContain("touch-pan-y");
  });

  it("a move over the card, the title and the hold button is never prevented, so the swipe is the browser's", () => {
    const { container } = draw(proposal(), HILL_IDLE);
    const hold = container.querySelector<HTMLElement>('[data-slot="chat-approval-option"][data-intent="on"]')!;
    const title = container.querySelector<HTMLElement>('[data-slot="chat-approval-title"]')!;
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 400 });
    for (const target of [hold, title]) {
      for (const type of ["touchmove", "pointermove", "wheel"] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        expect(event.defaultPrevented, `${type} on ${target.dataset.slot}`).toBe(false);
      }
    }
    fireEvent.pointerCancel(hold, { pointerId: 1, pointerType: "touch" });
  });

  it("the hold still approves on its own button", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatApprovalCard decision={proposal()} answer={HILL_IDLE} onSend={onSend} onLater={vi.fn()} />);
    const hold = container.querySelector<HTMLElement>('[data-slot="chat-approval-option"][data-intent="on"]')!;
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 400 });
    act(() => vi.advanceTimersByTime(APPROVE_HOLD_MS + 50));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("on");
  });

  it("a swipe the browser takes (pointercancel) ends the hold with no yes", () => {
    const onSend = vi.fn();
    const { container } = render(<ChatApprovalCard decision={proposal()} answer={HILL_IDLE} onSend={onSend} onLater={vi.fn()} />);
    const hold = container.querySelector<HTMLElement>('[data-slot="chat-approval-option"][data-intent="on"]')!;
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 400 });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.pointerCancel(hold, { pointerId: 1, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(APPROVE_HOLD_MS));
    expect(onSend).not.toHaveBeenCalled();
  });
});
