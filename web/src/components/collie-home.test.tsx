import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorBusy, beginBusy } from "@/lib/busy";
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
// ── THE BUSY SPIN: a DURATION, not an event ───────────────────────────────────────────────────
//
// The round is one turn and then it is over. This is the other shape: the orbit turns for exactly as
// long as the operator's work runs — no timer, no minimum. The cases pin both ends of that, plus the
// one state it is not allowed to overrule.
describe("CollieHome — the busy spin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
    __resetOperatorBusy();
  });
  afterEach(() => {
    act(() => clearStatus());
    act(() => __resetOperatorBusy());
    vi.useRealTimers();
  });

  it("turns while work is in flight and stops the moment it is released", () => {
    const { container } = render(<CollieHome trouble={false} />);
    expect(markIsLive(container)).toBe(false);

    let release!: () => void;
    act(() => {
      release = beginBusy();
    });
    expect(markIsLive(container)).toBe(true);

    // No timer runs it out — unlike the round, this is a state with a real duration, so it is still
    // turning long past the round's 1800ms.
    act(() => void vi.advanceTimersByTime(5000));
    expect(markIsLive(container)).toBe(true);

    act(() => release());
    expect(markIsLive(container)).toBe(false);
  });

  // `lost` is the mark held still and muted. A send fired into a link we have given up on must not
  // make the app look like it is trying again — the same contract the round already keeps.
  it("stays still while the connection is lost", () => {
    const { container } = render(<CollieHome trouble lost />);
    act(() => void beginBusy());
    expect(markIsLive(container)).toBe(false);
  });
});

describe("spinRate — the wheel-throw curve", () => {
  const T = 1800;

  it("starts and ends at a standstill, so neither join has a velocity step", () => {
    // This is what makes it a THROW rather than a film starting. The orbit used to jump from its 48s
    // drift to its 1.8s sprint in one frame and drop back just as hard; at both ends it now meets
    // the drift at zero.
    expect(spinRate(0, T)).toBeCloseTo(0, 10);
    expect(spinRate(T, T)).toBeCloseTo(0, 10);
  });

  it("throws quickly and coasts down slowly — the peak is BEFORE the middle", () => {
    // THE ASYMMETRY IS THE POINT, and it is the operator's second ask: "the slowdown can be even
    // smoother". The curve underneath is still a raised cosine; it runs on a warped clock, which
    // moves the peak early and stretches the tail. A symmetric curve decelerates exactly as hard as
    // it accelerates, and a thrown wheel does not — the hand is on it for a moment and gone.
    let peakAt = 0;
    for (let i = 0; i <= 2000; i++) {
      if (spinRate((i / 2000) * T, T) > spinRate(peakAt, T)) peakAt = (i / 2000) * T;
    }
    expect(peakAt / T).toBeGreaterThan(0.3);
    expect(peakAt / T).toBeLessThan(0.42);
    // So the slowdown owns most of the round rather than exactly half of it.
    expect(1 - peakAt / T).toBeGreaterThan(0.6);
    // The peak is higher than the symmetric curve's 2, and it MUST be: the turn is conserved (see
    // the mean test below), so a longer, gentler coast has to be paid for by a quicker throw.
    expect(spinRate(peakAt, T)).toBeGreaterThan(2);
    expect(spinRate(peakAt, T)).toBeLessThan(2.5);

    // …and it still rises and falls monotonically about that one peak, so there is no second push
    // inside one round.
    for (let i = 1; i <= 100; i++) {
      const rise = spinRate(peakAt * (i / 100), T);
      expect(rise).toBeGreaterThan(spinRate(peakAt * ((i - 1) / 100), T));
      const fall = spinRate(peakAt + (T - peakAt) * (i / 100), T);
      expect(fall).toBeLessThan(spinRate(peakAt + (T - peakAt) * ((i - 1) / 100), T));
    }
  });

  it("ends far gentler than the symmetric curve it replaced", () => {
    // The measurable half of "smoother". Compared against the OLD curve computed inline, so this is
    // a claim about the change and not just a snapshot of the new numbers: late in the round the
    // orbit is several times slower than the symmetric raised cosine was at the same instant.
    const symmetric = (at: number) => 1 - Math.cos((2 * Math.PI * at) / T);
    for (const frac of [0.8, 0.9, 0.95]) {
      expect(spinRate(frac * T, T)).toBeLessThan(symmetric(frac * T) / 2);
    }
    // The throw pays for it, at the other end, and that is the same fact rather than a regression.
    expect(spinRate(0.1 * T, T)).toBeGreaterThan(symmetric(0.1 * T));
  });

  it("has a mean of exactly 1, so the eased round still covers exactly one turn", () => {
    // THE LOAD-BEARING PROPERTY, and the reason the skew is expressed as a clock warp rather than as
    // a hand-shaped tail. `rate = (1 − cos 2πu)·u′` is a SUBSTITUTION, so ∫₀¹ rate dθ = ∫₀¹ (1 −
    // cos 2πu) du = 1 for ANY smooth increasing `u` — the mean is 1 by construction, not by a
    // constant somebody re-derived. So the easing only REDISTRIBUTES the turn in time: it spends
    // none of it and saves none of it, and SPIN_SKEW can be retuned by feel without this breaking.
    // A curve without this lands the orbit somewhere other than where it started, and the mark's
    // hand-off to the resting drift assumes it does not. Integrated numerically rather than asserted
    // symbolically, because what must hold is what the code computes, not what the comment claims.
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
    // Never negative anywhere in range. Both factors are non-negative by construction — a raised
    // cosine is bounded below by 0, and the clock's speed `u′ = 1 + s(1−2θ)` bottoms out at `1 − s`,
    // which is why SPIN_SKEW may not reach 1. Past it `u′` goes negative and the orbit would run
    // BACKWARDS through the last of the round. This is what says so if either is ever changed.
    for (let i = 0; i <= 200; i++) expect(spinRate((i / 200) * T, T)).toBeGreaterThanOrEqual(0);
  });
});
