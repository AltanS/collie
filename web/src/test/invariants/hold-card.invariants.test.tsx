// M102 spec 15, part 1b at the control: the hook hold card (components/hook-hold-card.tsx) under every
// ending its answer can have. The card hands a tap to its caller; the caller's promise resolves (the
// answer came back), rejects (it threw), or takes long. The invariant is the control's, not the reading's:
//
//   I2  every tap ends in a call to the caller, a visible change or words; after the caller's promise
//       ends, every option is live again; a disabled card says why.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HOLD_TAP_GUARD_MS, HookHoldCard } from "@/components/hook-hold-card";
import type { HoldNote } from "@/lib/surface/hold";


afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOTE: HoldNote = {
  state: "held",
  askId: "ask-hold-1",
  hash: "h1",
  tool: "Bash",
  input: "rm -rf build",
  options: ["Yes", "No"],
  adopted: false,
  agent: false,
  since: 0,
};

/** Everything a person sees in the card, as one string: a tap that changes none of it changed nothing. */
function visible(container: HTMLElement): string {
  const buttons = [...container.querySelectorAll("button")].map((b) => `${b.textContent ?? ""}:${b.disabled ? "off" : "on"}:${b.getAttribute("data-tone") ?? ""}:${b.className}`);
  return `${container.textContent ?? ""}|${buttons.join("|")}`;
}

describe("M102-15 part 1b, the hook hold card's taps", () => {
  for (const ending of ["resolves"] as const) {
    it(`I2: after the answer ${ending}, every option is live again`, async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const onAnswer = vi.fn(() => Promise.resolve());
      render(<HookHoldCard note={NOTE} onAnswer={onAnswer} />);
      act(() => vi.advanceTimersByTime(HOLD_TAP_GUARD_MS + 10));
      vi.setSystemTime(1_000_000 + HOLD_TAP_GUARD_MS + 10);
      const yes = screen.getByRole("button", { name: /Yes/ });
      await act(async () => {
        yes.click();
        await Promise.resolve();
      });
      expect(onAnswer).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
    });
  }

  it(`I2: an answer that rejects is handled and leaves words, and the options are live again`, async () => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: Error): void => {
      unhandled.push(reason.message);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.useFakeTimers({ now: 3_000_000 });
      const { container } = render(<HookHoldCard note={NOTE} onAnswer={() => Promise.reject(new Error("no answer"))} />);
      vi.setSystemTime(3_000_000 + HOLD_TAP_GUARD_MS + 10);
      const before = container.textContent ?? "";
      await act(async () => {
        screen.getByRole("button", { name: /Yes/ }).click();
        await Promise.resolve();
      });
      vi.useRealTimers();
      await new Promise((done) => setTimeout(done, 20));
      for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
      expect(unhandled).toEqual([]);
      expect(container.textContent ?? "").not.toBe(before);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it(`I2: a tap in the first ${String(HOLD_TAP_GUARD_MS)} ms makes a call, a visible change or words`, async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const onAnswer = vi.fn(() => Promise.resolve());
    const { container } = render(<HookHoldCard note={NOTE} onAnswer={onAnswer} />);
    const before = visible(container);
    await act(async () => {
      screen.getByRole("button", { name: /Yes/ }).click();
      await Promise.resolve();
    });
    const changed = visible(container) !== before;
    expect({ called: onAnswer.mock.calls.length > 0, changed }).not.toEqual({ called: false, changed: false });
  });

  it(`I1: a disabled hold card says why, next to its options`, () => {
    const live = render(<HookHoldCard note={NOTE} onAnswer={vi.fn()} />);
    const liveText = live.container.textContent ?? "";
    cleanup();
    const { container } = render(<HookHoldCard note={NOTE} onAnswer={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    // A reason is text the live card does not show. Today the two read the same.
    expect(container.textContent ?? "").not.toBe(liveText);
  });
});
