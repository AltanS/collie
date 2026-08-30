import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStatus, setStatus } from "@/lib/status";
import { markIsLive } from "@/test/collie-mark";
import { CollieHome, spinRate } from "./collie-home";

// THE ROUND IS AN EVENT, NOT A STATE. Any status the app publishes turns the orbit exactly once, at
// the loading rate, before handing it back to the resting drift. These cases hold the two halves of
// that sentence — exactly once, and back — plus the two states that outrank it.
describe("CollieHome — the event round", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
  });
  afterEach(() => {
    act(() => clearStatus());
    vi.useRealTimers();
  });

  it("turns the orbit for one round when a status is published, then stops", () => {
    const { container } = render(<CollieHome trouble={false} />);
    expect(markIsLive(container)).toBe(false);

    act(() => setStatus("claude is done · moonward", "success"));
    expect(markIsLive(container)).toBe(true);

    // Still turning one tick short of the round.
    act(() => void vi.advanceTimersByTime(1799));
    expect(markIsLive(container)).toBe(true);

    act(() => void vi.advanceTimersByTime(1));
    expect(markIsLive(container)).toBe(false);
  });

  // One action often publishes more than one status — the send acknowledges, then the pane's own
  // lifecycle moves. Each of those must NOT extend the round: an orbit that keeps going is a state
  // again, which is the one thing the round must not be mistaken for.
  it("does not extend the round when more statuses land while it is turning", () => {
    const { container } = render(<CollieHome trouble={false} />);

    act(() => setStatus("claude is done · moonward", "success"));
    act(() => void vi.advanceTimersByTime(900));
    act(() => setStatus("claude needs you · herdr", "warn"));
    expect(markIsLive(container)).toBe(true);

    act(() => void vi.advanceTimersByTime(900));
    expect(markIsLive(container)).toBe(false);
  });

  // `lost` is a state the mark holds still and muted for. A passing event must not light it up and
  // tell the reader something is working when the connection has been given up on.
  it("stays still while the connection is lost", () => {
    const { container } = render(<CollieHome trouble lost />);
    act(() => setStatus("claude is done · moonward", "success"));
    expect(markIsLive(container)).toBe(false);
  });

  // The connection bloom outranks the round: it is already the loading input, and it must still be
  // turning after the round's timer has run out.
  it("leaves the connection bloom turning after the round would have ended", () => {
    const { container } = render(<CollieHome trouble />);
    expect(markIsLive(container)).toBe(true);

    act(() => setStatus("claude is done · moonward", "success"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(markIsLive(container)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THROW — the round's rate curve.
//
// The operator, on the square-wave round it replaces: "would it be possible for the behavior to
// accelerate and decelerate when triggered? so it behaves kinda as if a human spun a wheel".
//
// `spinRate` is a raised cosine, and the reason it is THAT curve and not any other easing is the
// third case below: its mean over the round is exactly 1, so the eased round still covers exactly
// ONE turn in exactly the time the round lasts. Every other property of the round — the burst guard,
// the hand-off to the resting drift, the bloom outranking it — depends on that and would break
// silently under a curve that merely "looked" eased. This is the half of the throw that can be
// checked without eyes, so it is checked hard.
// ─────────────────────────────────────────────────────────────────────────────
describe("spinRate — the wheel-throw curve", () => {
  const T = 1800;

  it("starts and ends at a standstill, so neither join has a velocity step", () => {
    // This is what makes it a THROW rather than a film starting. The orbit used to jump from its 48s
    // drift to its 1.8s sprint in one frame and drop back just as hard; at both ends it now meets
    // the drift at zero.
    expect(spinRate(0, T)).toBeCloseTo(0, 10);
    expect(spinRate(T, T)).toBeCloseTo(0, 10);
  });

  it("peaks at twice the sprint, halfway through the throw", () => {
    expect(spinRate(T / 2, T)).toBeCloseTo(2, 10);
    // …and rises and falls monotonically to and from it, so there is no second push inside one round.
    for (let i = 1; i <= 100; i++) {
      const rise = spinRate((T / 2) * (i / 100), T);
      expect(rise).toBeGreaterThan(spinRate((T / 2) * ((i - 1) / 100), T));
      const fall = spinRate(T / 2 + (T / 2) * (i / 100), T);
      expect(fall).toBeLessThan(spinRate(T / 2 + (T / 2) * ((i - 1) / 100), T));
    }
  });

  it("has a mean of exactly 1, so the eased round still covers exactly one turn", () => {
    // THE LOAD-BEARING PROPERTY. ∫₀ᵀ(1 − cos(2πt/T))dt = T, so the easing only REDISTRIBUTES the
    // turn in time — it spends none of it and saves none of it. A curve without this lands the orbit
    // somewhere other than where it started, and the mark's hand-off to the resting drift assumes it
    // does not. Integrated numerically here rather than asserted symbolically, because the thing
    // that must hold is what the code computes, not what the comment claims.
    const steps = 20_000;
    let total = 0;
    for (let i = 0; i < steps; i++) total += spinRate(((i + 0.5) / steps) * T, T);
    expect(total / steps).toBeCloseTo(1, 6);
  });

  it("clamps outside the round and never divides by zero", () => {
    // A frame can land past the end (the loop and the timeout are separate clocks), and it must read
    // as "stopped", never as a negative rate that would run the orbit backwards.
    expect(spinRate(-500, T)).toBeCloseTo(0, 10);
    expect(spinRate(T + 500, T)).toBeCloseTo(0, 10);
    expect(spinRate(50, 0)).toBe(1);
    // Never negative anywhere in range: a raised cosine is bounded below by 0 by construction, and
    // this is what says so if the curve is ever changed.
    for (let i = 0; i <= 200; i++) expect(spinRate((i / 200) * T, T)).toBeGreaterThanOrEqual(0);
  });
});
