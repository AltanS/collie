import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { STILL_MS } from "@/hooks/use-still";
import type { HillDecision, HillGroupAnswer } from "@/lib/hill/wire";
import { collieCard } from "@/test/hill-fixtures";
import { stubAllSeen } from "@/test/seen-end";
import { DecisionCard } from "./decision-card";

// SECURITY READ OF PACKAGE I, point 2 (2026-11-17): a trick's card yes is enabled only when the end of the
// code was seen AND the card has stood still for a second; a touch that began before is not a tap on it;
// and once it is enabled, ONE tap answers. The proposal's card and the version's card, alike.

const CODE: HillDecision["view"] = [{ kind: "diff", text: "@@ -0,0 +1,1 @@\n+console.log(1);", attrs: { file: "program.ts" } }];
let top = 200;

beforeEach(() => {
  vi.useFakeTimers();
  top = 200;
  stubAllSeen();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 300, 80));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function draw(kind: keyof typeof CARDS) {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  const view = render(<DecisionCard decision={CARDS[kind]()} answer={HILL_IDLE} onSend={onSend} />);
  const yesIntent = kind === "proposal" ? "on" : "use";
  const noIntent = kind === "proposal" ? "later" : "keep";
  const option = (intent: string) => view.container.querySelector<HTMLButtonElement>(`[data-slot="decision-option"][data-intent="${intent}"]`)!;
  return { onSend, yes: () => option(yesIntent), no: () => option(noIntent) };
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe.each(["proposal", "version"] as const)("the %s card's yes is one tap that waits for the card to stand still", (kind) => {
  it("is off at the draw even with the code seen, on after a second, and Not now is never held", () => {
    const { yes, no } = draw(kind);
    expect(yes()).toBeDisabled();
    expect(no()).toBeEnabled();
    wait(STILL_MS + 200);
    expect(yes()).toBeEnabled();
  });

  it("a card that shifts is off again, and on a second after it settled", () => {
    const { yes } = draw(kind);
    wait(STILL_MS + 200);
    expect(yes()).toBeEnabled();
    top = 260;
    wait(200);
    expect(yes()).toBeDisabled();
    wait(STILL_MS + 200);
    expect(yes()).toBeEnabled();
  });

  it("a touch that began before the yes was enabled does not send, and the next whole tap sends once", () => {
    const { yes, onSend } = draw(kind);
    // The thumb lands while the button is off, and lifts after it came on.
    fireEvent.pointerDown(yes());
    wait(STILL_MS + 200);
    fireEvent.click(yes(), { detail: 1 });
    expect(onSend).not.toHaveBeenCalled();
    // A whole tap, begun after: one tap, one answer, no second confirming tap.
    fireEvent.pointerDown(yes());
    fireEvent.click(yes(), { detail: 1 });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a keyboard activation, which has no touch, sends once the yes is on", () => {
    const { yes, onSend } = draw(kind);
    wait(STILL_MS + 200);
    fireEvent.click(yes(), { detail: 0 });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
