import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { extractInputDraft } from "@/lib/harness/claude/chrome";
import { isSelfEcho, useStableTerminalDraft } from "./use-terminal-draft";

// The stabiliser is what makes the parse's transient false positive (our own reply flashing on the
// "❯" line during the bridge's send_text→Enter gap) non-actionable, while still surfacing a genuinely
// stranded draft that persists. Drive it with the REAL captures the parse reads, so the two can't
// drift: send-inflight → "/rename" (the flash), rename-resolved → null, done → a real stranded draft.
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
function fixtureDraft(name: string): string | null {
  return extractInputDraft(splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8"))));
}

const INFLIGHT = fixtureDraft("claude--send-inflight.txt"); // "/rename"
const STRANDED = fixtureDraft("claude--done.txt"); // "cat hello.txt to verify"

const MIN_AGE = 1_500;

describe("useStableTerminalDraft — cross-poll debounce (mitigation B)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts null and stays null while there is no draft", () => {
    const { result } = renderHook(() => useStableTerminalDraft(null));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(MIN_AGE * 2));
    expect(result.current).toBeNull();
  });

  it("suppresses a one-poll flash of our own send (the in-flight echo)", () => {
    // The '/rename' the parse read off the mid-send frame appears for less than the min age, then the
    // command submits and the line clears — it must never surface as a stranded draft.
    const { result, rerender } = renderHook(({ raw }) => useStableTerminalDraft(raw), {
      initialProps: { raw: INFLIGHT },
    });
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(MIN_AGE - 200)); // still within the flash window
    expect(result.current).toBeNull();
    rerender({ raw: fixtureDraft("claude--rename-resolved.txt") }); // resolved → null
    act(() => vi.advanceTimersByTime(MIN_AGE * 2));
    expect(result.current).toBeNull();
  });

  it("surfaces a genuinely stranded draft once it has persisted past the min age", () => {
    const { result } = renderHook(() => useStableTerminalDraft(STRANDED));
    expect(result.current).toBeNull(); // not on the first observation
    act(() => vi.advanceTimersByTime(MIN_AGE - 1));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(STRANDED);
  });

  it("keeps surfacing the same draft across later polls (unchanged raw doesn't reset it)", () => {
    const { result, rerender } = renderHook(({ raw }) => useStableTerminalDraft(raw), {
      initialProps: { raw: STRANDED },
    });
    act(() => vi.advanceTimersByTime(MIN_AGE));
    expect(result.current).toBe(STRANDED);
    rerender({ raw: STRANDED }); // another poll, same text
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(STRANDED);
  });

  it("a changed draft resets the clock (re-delays before surfacing the new text)", () => {
    const { result, rerender } = renderHook(({ raw }) => useStableTerminalDraft(raw), {
      initialProps: { raw: STRANDED },
    });
    act(() => vi.advanceTimersByTime(MIN_AGE));
    expect(result.current).toBe(STRANDED);
    rerender({ raw: "edited in the terminal" });
    expect(result.current).toBeNull(); // the old stable value drops immediately
    act(() => vi.advanceTimersByTime(MIN_AGE - 1));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("edited in the terminal");
  });

  it("clears immediately when the draft goes away", () => {
    const { result, rerender } = renderHook(({ raw }) => useStableTerminalDraft(raw), {
      initialProps: { raw: STRANDED as string | null },
    });
    act(() => vi.advanceTimersByTime(MIN_AGE));
    expect(result.current).toBe(STRANDED);
    rerender({ raw: null });
    expect(result.current).toBeNull();
  });
});

describe("isSelfEcho — match-last-sent comparison (mitigation A)", () => {
  it("matches the exact text we sent", () => {
    expect(isSelfEcho("/rename", "/rename")).toBe(true);
  });

  it("matches despite mirror whitespace padding / re-flow", () => {
    expect(isSelfEcho("  fix   the   flaky test ", "fix the flaky test")).toBe(true);
  });

  it("matches a truncated head of a long reply (mirror ellipsis on the input line)", () => {
    const sent = "please refactor the socket client to use the new adapter interface";
    expect(isSelfEcho("please refactor the socket client to use…", sent)).toBe(true);
  });

  it("does not match an unrelated stranded draft", () => {
    expect(isSelfEcho("cat hello.txt to verify", "/rename")).toBe(false);
  });

  it("does not false-match on a tiny shared prefix", () => {
    // Below the min-head guard, a coincidental leading char must not read as our echo.
    expect(isSelfEcho("go", "goodbye everyone, this is a long message")).toBe(false);
  });
});
