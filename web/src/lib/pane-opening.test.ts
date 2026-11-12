import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPENING_GIVE_UP_MS,
  OPENING_SHOWN_MS,
  beginOpening,
  endOpening,
  endOpeningsOf,
  resetOpenings,
  useOpeningShown,
} from "./pane-opening";

const SCREEN = Symbol("screen");
const KEY = "/pane/w1%3Ap1";

describe("pane opening", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    resetOpenings();
    vi.useRealTimers();
  });

  it("the first tap begins and a second tap on the same row is refused", () => {
    expect(beginOpening(KEY, SCREEN)).toBe(true);
    expect(beginOpening(KEY, SCREEN)).toBe(false);
  });

  it("another row opens freely", () => {
    beginOpening(KEY, SCREEN);
    expect(beginOpening("/pane/w1%3Ap2", SCREEN)).toBe(true);
  });

  it("shows no mark before the glide's wait is over, and a read that is in by then never shows one", () => {
    const { result } = renderHook(() => useOpeningShown(KEY));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS - 1));
    expect(result.current).toBe(false);
    act(() => endOpening(KEY));
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(result.current).toBe(false);
  });

  it("shows the mark when the read is still out at 120ms, and clears it when the read settles", () => {
    const { result } = renderHook(() => useOpeningShown(KEY));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(result.current).toBe(true);
    act(() => endOpening(KEY));
    expect(result.current).toBe(false);
  });

  it("only the opening row shows the mark", () => {
    const other = renderHook(() => useOpeningShown("/pane/w1%3Ap2"));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(other.result.current).toBe(false);
  });

  it("a row with no glide key never shows a mark", () => {
    const { result } = renderHook(() => useOpeningShown(undefined));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(result.current).toBe(false);
  });

  it("leaving the screen that began the open clears the mark and frees the row", () => {
    const { result } = renderHook(() => useOpeningShown(KEY));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    act(() => endOpeningsOf(SCREEN));
    expect(result.current).toBe(false);
    expect(beginOpening(KEY, SCREEN)).toBe(true);
  });

  it("leaving another screen leaves this one's open alone", () => {
    beginOpening(KEY, SCREEN);
    endOpeningsOf(Symbol("elsewhere"));
    expect(beginOpening(KEY, SCREEN)).toBe(false);
  });

  it("a read that never answers cannot leave the row dead: the open gives up", () => {
    const { result } = renderHook(() => useOpeningShown(KEY));
    beginOpening(KEY, SCREEN);
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(OPENING_GIVE_UP_MS));
    expect(result.current).toBe(false);
    expect(beginOpening(KEY, SCREEN)).toBe(true);
  });
});
