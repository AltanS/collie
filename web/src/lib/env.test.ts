import { afterEach, describe, expect, it, vi } from "vitest";

import { abortSignalAfter, abortSignalAny } from "./env";

// An older WebView has neither `AbortSignal.timeout` nor `AbortSignal.any`. A request there must still
// end in its time limit, so a send with no answer ends in words (M102 spec 11, decision 2).
describe("no tap vanishes: the time limit holds without AbortSignal.timeout and AbortSignal.any", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A global `AbortSignal` with neither `timeout` nor `any`, as an older WebView has it. */
  function oldWebView(): void {
    vi.stubGlobal("AbortSignal", function OldAbortSignal() {});
  }

  it("no tap vanishes: a timer signal aborts after its time with a TimeoutError", () => {
    vi.useFakeTimers();
    oldWebView();
    const signal = abortSignalAfter(20_000);
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("no tap vanishes: a joined signal aborts when the first of its sources does", () => {
    oldWebView();
    const caller = new AbortController();
    const timer = new AbortController();
    const joined = abortSignalAny([caller.signal, timer.signal]);
    expect(joined!.aborted).toBe(false);
    timer.abort(new DOMException("late", "TimeoutError"));
    expect(joined!.aborted).toBe(true);
    expect(joined!.reason).toMatchObject({ message: "late" });
  });
});
