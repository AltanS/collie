import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRESS_MAX_MS,
  RELEASE_GRACE_MS,
  cancelPress,
  clearPress,
  markPressHeld,
  redirectClick,
  releasePress,
  rememberPress,
  resetPressMemory,
} from "./press-memory";

const A = Symbol("a");
const B = Symbol("b");

describe("press memory", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    resetPressMemory();
    vi.useRealTimers();
  });

  it("a click on the pressed row runs that row's own tap", () => {
    rememberPress(A, vi.fn());
    expect(redirectClick(A, true)).toBe("own");
  });

  it("a click on another row, while the press is live, opens the pressed row", () => {
    const open = vi.fn();
    rememberPress(A, open);
    const route = redirectClick(B, true);
    expect(route).toBe(open);
  });

  it("consumes the press: a second click on the neighbour is its own tap", () => {
    rememberPress(A, vi.fn());
    redirectClick(B, true);
    expect(redirectClick(B, true)).toBe("own");
  });

  it("with no press in memory, every click is the row's own", () => {
    expect(redirectClick(B, true)).toBe("own");
  });

  it("a keyboard or screen-reader click (no pointer behind it) is never redirected", () => {
    rememberPress(A, vi.fn());
    expect(redirectClick(B, false)).toBe("own");
  });

  it("a press that became a hold swallows the click the shifted list sends to a neighbour", () => {
    rememberPress(A, vi.fn());
    markPressHeld(A);
    expect(redirectClick(B, true)).toBe("swallow");
  });

  it("a hold on another row does not mark this press held", () => {
    const open = vi.fn();
    rememberPress(A, open);
    markPressHeld(B);
    expect(redirectClick(B, true)).toBe(open);
  });

  it("the browser taking the touch (a scroll) ends the press", () => {
    rememberPress(A, vi.fn());
    cancelPress(A);
    expect(redirectClick(B, true)).toBe("own");
  });

  it("a cancel from another row leaves the press alone", () => {
    const open = vi.fn();
    rememberPress(A, open);
    cancelPress(B);
    expect(redirectClick(B, true)).toBe(open);
  });

  it("a lifted press is still on offer to the click that follows the lift", () => {
    const open = vi.fn();
    rememberPress(A, open);
    releasePress(A);
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(redirectClick(B, true)).toBe(open);
  });

  it("a lifted press expires: a click long after it is never aimed back at it", () => {
    rememberPress(A, vi.fn());
    releasePress(A);
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(redirectClick(B, true)).toBe("own");
  });

  it("a new press replaces the old one, and the old one's expiry does not end the new", () => {
    const openB = vi.fn();
    rememberPress(A, vi.fn());
    releasePress(A);
    rememberPress(B, openB);
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 10);
    expect(redirectClick(A, true)).toBe(openB);
  });
  it("a press that never lifts ends at the ceiling: a click long after is never aimed back at it", () => {
    rememberPress(A, vi.fn());
    vi.advanceTimersByTime(PRESS_MAX_MS - 1);
    expect(redirectClick(B, true)).not.toBe("own");
    rememberPress(A, vi.fn());
    vi.advanceTimersByTime(PRESS_MAX_MS);
    expect(redirectClick(B, true)).toBe("own");
  });

  it("the ceiling counts from the press, not from the lift", () => {
    rememberPress(A, vi.fn());
    vi.advanceTimersByTime(PRESS_MAX_MS - 100);
    releasePress(A);
    vi.advanceTimersByTime(100);
    expect(redirectClick(B, true)).toBe("own");
  });

  it("a right or middle button clears the press in memory", () => {
    rememberPress(A, vi.fn());
    clearPress();
    expect(redirectClick(B, true)).toBe("own");
  });

  it("clearing with nothing in memory is a no-op", () => {
    expect(() => clearPress()).not.toThrow();
  });
});
