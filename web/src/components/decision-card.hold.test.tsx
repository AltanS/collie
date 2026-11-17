import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";
import { DecisionCard } from "./decision-card";

// THE YES TO A TRICK'S CODE ON THE HILL AND IN SETTINGS IS A HOLD OF 1.5 SECONDS (ADR 0156). The proposal's
// card and the version's card, alike: nothing has to be read or scrolled first, the yes carries the digest of
// the code the card showed, and the decline stays one tap. A card with no code offers no yes at all.

const HASH = "a".repeat(64);
const CODE: HillDecision["view"] = [{ kind: "diff", text: "@@ -0,0 +1,1 @@\n+console.log(1);", attrs: { file: "program.ts" } }];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CARDS = {
  proposal: () => collieCard("proposal", "legs", { view: CODE, options: [{ intent: "on", label: "Switch it on" }, { intent: "later", label: "Not now" }] }),
  version: () =>
    collieCard("version", "legs", {
      view: CODE,
      options: [
        { intent: "use", label: "Use the new version" },
        { intent: "keep", label: "Keep the old version" },
      ],
    }),
} as const;

function draw(decision: HillDecision, yesIntent: string, noIntent: string) {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  const view = render(<DecisionCard decision={decision} answer={HILL_IDLE} onSend={onSend} />);
  const option = (intent: string) => view.container.querySelector<HTMLButtonElement>(`[data-slot="decision-option"][data-intent="${intent}"]`);
  return { onSend, yes: () => option(yesIntent), no: () => option(noIntent)! };
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe.each([
  ["proposal", "on", "later", "Hold to switch on"],
  ["version", "use", "keep", "Hold to use"],
] as const)("the %s card's yes is a hold", (kind, yesIntent, noIntent, word) => {
  it("is on at the draw, says it is a hold, and a hold of 1.5 seconds sends once with the digest; nothing is read first", () => {
    const { yes, onSend } = draw(CARDS[kind](), yesIntent, noIntent);
    expect(yes()).toBeEnabled();
    expect(yes()!).toHaveAccessibleName(word);
    fireEvent.pointerDown(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
    wait(APPROVE_HOLD_MS - 100);
    expect(onSend).not.toHaveBeenCalled();
    wait(100);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(yesIntent, null, { digest: HASH, opened: [1] });
  });

  it("a tap is no yes, and a lift before 1.5 seconds sends nothing", () => {
    const { yes, onSend } = draw(CARDS[kind](), yesIntent, noIntent);
    fireEvent.pointerDown(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
    fireEvent.click(yes()!, { detail: 1 });
    fireEvent.pointerDown(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
    wait(APPROVE_HOLD_MS - 100);
    fireEvent.pointerUp(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
    fireEvent.click(yes()!, { detail: 1 });
    wait(5000);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a key presses twice", () => {
    const { yes, onSend } = draw(CARDS[kind](), yesIntent, noIntent);
    fireEvent.click(yes()!, { detail: 0 });
    expect(onSend).not.toHaveBeenCalled();
    wait(500);
    fireEvent.click(yes()!, { detail: 0 });
    expect(onSend).toHaveBeenCalledWith(yesIntent, null, { digest: HASH, opened: [1] });
  });

  it("the decline stays one tap", () => {
    const { no, onSend } = draw(CARDS[kind](), yesIntent, noIntent);
    fireEvent.click(no(), { detail: 1 });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe(noIntent);
  });

  it("a card with no code offers no yes, only the decline and the line that says why", () => {
    const bare = { ...CARDS[kind](), view: [{ kind: "para", text: "No code." }] } satisfies HillDecision;
    const { yes, no } = draw(bare, yesIntent, noIntent);
    expect(yes()).toBeNull();
    expect(no()).toBeEnabled();
    expect(document.querySelector('[data-slot="decision-code-unshown"]')).not.toBeNull();
  });
});

it("a version's second yes, Use it and stop asking, is a hold of its own words", () => {
  const card = collieCard("version", "legs", {
    view: CODE,
    options: [
      { intent: "use", label: "Use the new version" },
      { intent: "always", label: "Use it and stop asking", detail: "Later changes are taken without asking." },
      { intent: "keep", label: "Keep the old version" },
    ],
  });
  const { yes, onSend } = draw(card, "always", "keep");
  expect(yes()!).toHaveAccessibleName(/^Hold to use and stop asking/u);
  expect(yes()!).toHaveTextContent("Later changes are taken without asking.");
  fireEvent.pointerDown(yes()!, { button: 0, pointerId: 1, pointerType: "touch" });
  wait(APPROVE_HOLD_MS);
  expect(onSend).toHaveBeenCalledWith("always", null, { digest: HASH, opened: [1] });
});

it("a proposal of a new version says Hold to use, not Hold to switch on", () => {
  const card = collieCard("proposal", "legs", { view: CODE, options: [{ intent: "on", label: "Use the new version" }, { intent: "later", label: "Keep the old version" }] });
  const { yes } = draw(card, "on", "later");
  expect(yes()!).toHaveAccessibleName("Hold to use");
});

// On the Hill and in Settings the card leaves its page after an answer. Until it leaves, nothing jumps: the options
// stay, the chosen one with a check mark, the other disabled, and no receipt takes their place.
describe("after an answer, until the card leaves, the options stay", () => {
  const ok = (intent: string) => ({
    phase: "answered" as const,
    intent,
    text: null,
    receipt: { rid: "r", code: "ok" as const, reason: null, state: "answered" as const, delivery: "typed" as const, trick: null, at: 0 },
  });
  it.each([
    ["switched on", "on", "later"],
    ["declined", "later", "on"],
  ])("%s", (_, chosen, other) => {
    const decision = CARDS.proposal();
    const view = render(<DecisionCard decision={decision} answer={HILL_IDLE} onSend={vi.fn()} />);
    const options = () => [...view.container.querySelectorAll<HTMLButtonElement>('[data-slot="decision-option"]')];
    const before = options();
    view.rerender(<DecisionCard decision={decision} answer={{ phase: "sending", intent: chosen, text: null }} onSend={vi.fn()} />);
    view.rerender(<DecisionCard decision={decision} answer={ok(chosen)} onSend={vi.fn()} />);
    // Past the moment the old card swapped its options for the receipt.
    wait(5000);
    const after = options();
    expect(after).toHaveLength(before.length);
    after.forEach((button, i) => expect(button).toBe(before[i]));
    expect(after.find((b) => b.dataset.intent === chosen)?.querySelector('[data-slot="option-chosen-mark"]')).not.toBeNull();
    expect(after.find((b) => b.dataset.intent === other)).toBeDisabled();
  });
});

describe("no row, line or box comes or goes after an answer, on the Hill and in Settings", () => {
  const elements = (root: Element) => [...root.querySelectorAll("*")].filter((el) => el.closest("svg") === null);
  it.each(["on", "later"])("answer %s", (intent) => {
    const decision = CARDS.proposal();
    const view = render(<DecisionCard decision={decision} answer={HILL_IDLE} onSend={vi.fn()} />);
    const before = elements(view.container);
    view.rerender(<DecisionCard decision={decision} answer={{ phase: "sending", intent, text: null }} onSend={vi.fn()} />);
    wait(5000);
    expect(elements(view.container)).toEqual(before);
    view.rerender(
      <DecisionCard
        decision={decision}
        answer={{ phase: "answered", intent, text: null, receipt: { rid: "r", code: "ok", reason: null, state: "answered", delivery: "typed", trick: null, at: 0 } }}
        onSend={vi.fn()}
      />,
    );
    wait(5000);
    expect(elements(view.container)).toEqual(before);
  });
});
