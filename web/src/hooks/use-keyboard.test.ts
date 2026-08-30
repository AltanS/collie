import { describe, expect, it } from "vitest";

import { keyboardLikelyOpen, nextKeyboardOpen } from "./use-keyboard";

describe("keyboardLikelyOpen", () => {
  it("is closed when the height is unchanged", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });

  it("ignores small drops like the URL bar collapsing", () => {
    expect(keyboardLikelyOpen(800, 720)).toBe(false); // -80px
  });

  it("is open when the height drops past a keyboard-sized amount", () => {
    expect(keyboardLikelyOpen(800, 480)).toBe(true); // -320px
  });

  it("is closed again once the height returns to baseline", () => {
    expect(keyboardLikelyOpen(800, 800)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYSTERESIS — the answer depends on where we were, not only on how far down we are.
//
// One threshold is right for gating a strip and wrong the moment layout hangs off the answer: a
// viewport hovering at the boundary (split screen, a floating keyboard, a predictive-text bar, a
// keyboard animating shut in steps) flips the boolean repeatedly, and each flip now moves a third of
// the screen. These pin the dead band between 100 and 150 in BOTH directions — a single-threshold
// "tidy-up" fails at least one of them whichever number it picks.
// ─────────────────────────────────────────────────────────────────────────────
describe("nextKeyboardOpen", () => {
  it("needs a keyboard-sized drop to open, and the URL bar is not one", () => {
    expect(nextKeyboardOpen(false, 800, 720)).toBe(false); // -80px
    expect(nextKeyboardOpen(false, 800, 660)).toBe(false); // -140px, still inside the dead band
    expect(nextKeyboardOpen(false, 800, 480)).toBe(true); // -320px
  });

  it("stays open across a drop that would not have opened it", () => {
    // The keyboard shrinking (a predictive-text bar collapsing, a split keyboard) must not be read
    // as the keyboard leaving. -140px is below the OPEN threshold and above the CLOSE one.
    expect(nextKeyboardOpen(true, 800, 660)).toBe(true);
    expect(nextKeyboardOpen(true, 800, 690)).toBe(true); // -110px
  });

  it("closes only once the height has come most of the way back", () => {
    expect(nextKeyboardOpen(true, 800, 720)).toBe(false); // -80px, back inside the closed band
    expect(nextKeyboardOpen(true, 800, 800)).toBe(false);
  });

  it("cannot strand the operator in a composing layout with no keyboard", () => {
    // `baseline` only ratchets UP, so a URL bar hiding raises it for the rest of the session. With
    // the close test at the same 150 as the open test, a genuinely-closed keyboard would sit inside
    // the dead band forever. The error is bounded by the URL bar's own height, which is under 100.
    const baselineRaisedByUrlBar = 880;
    expect(nextKeyboardOpen(true, baselineRaisedByUrlBar, 800)).toBe(false); // -80px
  });
});
