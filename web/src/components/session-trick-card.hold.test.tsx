import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentViewScreen } from "@/components/agent-view-screen";
import { ChatApprovalCard } from "@/components/session-trick-card";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";

// THE CHAT CARD'S YES IS A HOLD OF 1.5 SECONDS (ADR 0156), in the chat's own scroll and in an agent view's own
// scroll, where the card stands while the view stands in for the chat. The fold is never opened in these cases:
// reading is offered, not required. A scroll of the box the card flows in does not end a hold (fix/hold-works); the
// decline stays one tap.

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
  it("is ready at the draw with the fold never opened, and a hold of 1.5 seconds sends once with the hash", () => {
    const { onSend, yes, toggle } = draw(host);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(yes()).toBeEnabled();
    expect(yes()).toHaveTextContent("Hold to switch on");
    down(yes()!);
    wait(APPROVE_HOLD_MS - 1);
    expect(onSend).not.toHaveBeenCalled();
    wait(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("on", null, { digest: HASH, opened: [1] });
    up(yes()!);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("a lift just short of the hold sends nothing; a tap sends nothing", () => {
    const { onSend, yes } = draw(host);
    down(yes()!);
    up(yes()!);
    down(yes()!);
    wait(APPROVE_HOLD_MS - 100);
    up(yes()!);
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a scroll of the box the card flows in, while the finger holds, does not end the hold (the chat's own follow scrolls it)", () => {
    const { onSend, yes, box } = draw(host);
    down(yes()!);
    wait(APPROVE_HOLD_MS / 2);
    fireEvent.scroll(box);
    wait(APPROVE_HOLD_MS / 2);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a key presses twice", () => {
    const { onSend, yes } = draw(host);
    fireEvent.click(yes()!, { detail: 0 });
    expect(yes()).toHaveTextContent("Press again to confirm");
    wait(500);
    fireEvent.click(yes()!, { detail: 0 });
    expect(onSend).toHaveBeenCalledWith("on", null, { digest: HASH, opened: [1] });
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

const ok = (intent: string): HillAnswerState => ({
  phase: "answered",
  intent,
  text: null,
  receipt: { rid: "r", code: "ok", reason: null, state: "answered", delivery: "typed", trick: null, at: 0 },
});

describe.each(["chat", "agent-view"] as const)("the card's colour says where it stands, in the %s", (host) => {
  const cases: [string, HillAnswerState, HillDecision, RegExp][] = [
    ["waits for the person: the needs-you red-orange", HILL_IDLE, decision, /border-status-blocked\/50 bg-status-blocked\/8/u],
    ["a yes in flight still waits", { phase: "sending", intent: "on", text: null }, decision, /border-status-blocked\//u],
  ];
  for (const [what, answer, shown, surface] of cases) {
    it(what, () => {
      const card = <ChatApprovalCard decision={shown} answer={answer} onSend={vi.fn()} onLater={vi.fn()} />;
      const view = render(
        host === "chat" ? (
          card
        ) : (
          <AgentViewScreen name="Morph" session="lodge/%3#abcd" view={undefined} working={false} entries={[]} canAct onTap={vi.fn()} onLink={vi.fn()} now={Date.parse("2026-11-17T10:00:00.000Z")} settleMs={0} tail={card} />
        ),
      );
      const root = view.container.querySelector<HTMLElement>('[data-slot="chat-approval"]')!;
      const panel = root.querySelector<HTMLElement>('[role="group"]')!;
      expect(panel.className).toMatch(surface);
      // A uniform border on all four sides and no left accent; the old amber tint is gone.
      expect(panel.className).not.toMatch(/border-l-|status-working|\bbg-card\b|\bborder-border\b/u);
    });
  }
});

// THE OPTIONS STAY WHILE THE ANSWER IS IN FLIGHT (Altan, 2026-11-17: "the yes option disappears causing a layout switch,
// it should stay but receive a checkmark"): the same buttons, in the same places, the other disabled. Once the answer
// landed the card is one line (Altan, 2026-11-18). jsdom has no layout, so "the same place" is held as the same nodes
// in the same order.
describe.each(["chat", "agent-view"] as const)("after an answer the options stay, in the %s", (host) => {
  function drawWith(answer: HillAnswerState) {
    const card = (a: HillAnswerState) => <ChatApprovalCard decision={decision} answer={a} onSend={vi.fn()} onLater={vi.fn()} />;
    const wrap = (a: HillAnswerState) =>
      host === "chat" ? (
        card(a)
      ) : (
        <AgentViewScreen name="Morph" session="lodge/%3#abcd" view={undefined} working={false} entries={[]} canAct onTap={vi.fn()} onLink={vi.fn()} now={Date.parse("2026-11-17T10:00:00.000Z")} settleMs={0} tail={card(a)} />
      );
    const view = render(wrap(answer));
    const options = () => [...view.container.querySelectorAll<HTMLButtonElement>('[data-slot="chat-approval-option"]')];
    return { view, options, redraw: (a: HillAnswerState) => view.rerender(wrap(a)) };
  }

  it.each([
    ["switched on", "on"],
    ["declined", "later"],
  ])("%s: the whole card collapses into one line, which is no card and holds no button", (_, chosen) => {
    const { view, redraw } = drawWith(HILL_IDLE);
    redraw({ phase: "sending", intent: chosen, text: null });
    redraw(ok(chosen));
    expect(view.container.querySelector('[data-slot="chat-approval"]')).toBeNull();
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.querySelector('[data-slot="chat-approval-line"]')).not.toBeNull();
  });

  it("a yes in flight: the spinner on the chosen option, the other disabled, no row moves", () => {
    const { options, redraw } = drawWith(HILL_IDLE);
    const before = options();
    redraw({ phase: "sending", intent: "on", text: null });
    const after = options();
    after.forEach((button, i) => expect(button).toBe(before[i]));
    expect(after.find((b) => b.dataset.intent === "later")).toBeDisabled();
  });
});

// NO NEW BOXES (Altan, 2026-11-18: "there is an ok row appearing, instead the selection should change, no new boxes").
// After an answer that did not land (or while one is in flight) the card holds the same elements in the same order as before it. The one thing that
// may come into the page is the mark in an option's own 16px slot (the spinner, the check), an icon in a slot that was
// there all along, so the list below leaves icons out.
const elements = (root: Element) => [...root.querySelectorAll("*")].filter((el) => el.closest("svg") === null);

describe.each(["chat", "agent-view"] as const)("no row, line or box comes or goes after an answer, in the %s", (host) => {
  const refused: HillAnswerState = {
    phase: "answered",
    intent: "on",
    text: null,
    receipt: { rid: "r", code: "rejected", reason: "These cards changed since this phone showed them.", state: "open", delivery: null, trick: null, at: 0 },
  };
  it.each<[string, HillAnswerState[]]>([
    ["a yes in flight", [{ phase: "sending", intent: "on", text: null }]],
    ["no answer came back", [{ phase: "sending", intent: "on", text: null }, { phase: "failed", intent: "on", text: null }]],
    ["refused", [{ phase: "sending", intent: "on", text: null }, refused]],
  ])("%s", (_, steps) => {
    const card = (a: HillAnswerState) => <ChatApprovalCard decision={decision} answer={a} onSend={vi.fn()} onLater={vi.fn()} />;
    const wrap = (a: HillAnswerState) =>
      host === "chat" ? (
        card(a)
      ) : (
        <AgentViewScreen name="Morph" session="lodge/%3#abcd" view={undefined} working={false} entries={[]} canAct onTap={vi.fn()} onLink={vi.fn()} now={Date.parse("2026-11-17T10:00:00.000Z")} settleMs={0} tail={card(a)} />
      );
    const view = render(wrap(HILL_IDLE));
    const root = () => view.container.querySelector('[data-slot="chat-approval"]')!;
    const before = elements(root());
    for (const step of steps) {
      view.rerender(wrap(step));
      act(() => vi.advanceTimersByTime(5000));
      expect(elements(root())).toEqual(before);
    }
    expect(root().querySelector('[data-slot="chat-approval-status"]')).toBeNull();
  });
});
