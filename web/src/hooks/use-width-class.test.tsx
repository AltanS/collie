import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";

import { useWidthClass } from "./use-width-class";

type Listener = (e: MediaQueryListEvent) => void;

// The change listeners each query registered, so a test can resize the window after mount.
const listeners = new Map<string, Set<Listener>>();
let size = { width: 0, height: 0 };

function matchesNow(query: string): boolean {
  const minW = /min-width:\s*(\d+)px/.exec(query);
  const minH = /min-height:\s*(\d+)px/.exec(query);
  return (minW === null || size.width >= Number(minW[1])) && (minH === null || size.height >= Number(minH[1]));
}

// A window of the given size, as a media query list answers `min-width` and `min-height` for it.
function window_(width: number, height: number): void {
  size = { width, height };
  vi.stubGlobal("matchMedia", (query: string) => {
    const set = listeners.get(query) ?? new Set<Listener>();
    listeners.set(query, set);
    // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
    return {
      matches: matchesNow(query),
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: Listener) => void set.add(fn),
      removeEventListener: (_: string, fn: Listener) => void set.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

// The window changes size after mount: every registered query re-evaluates and tells its listeners.
function resize_(width: number, height: number): void {
  size = { width, height };
  act(() => {
    for (const [query, set] of listeners) {
      // SAFETY: the hook reads only `matches` from the event.
      const event = { matches: matchesNow(query) } as MediaQueryListEvent;
      for (const fn of set) fn(event);
    }
  });
}

// A field that types, in the document and focused.
function focusedField(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  return field;
}

beforeEach(() => __resetWideLayoutStore());
afterEach(() => {
  document.body.replaceChildren();
  listeners.clear();
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

describe("useWidthClass", () => {
  it("is compact on a phone held sideways, 915 by 412", () => {
    window_(915, 412);
    expect(renderHook(() => useWidthClass()).result.current).toBe("compact");
  });

  it("is medium at 600 by 480 and 800 by 600, expanded at 915 by 600", () => {
    window_(600, 480);
    expect(renderHook(() => useWidthClass()).result.current).toBe("medium");
    window_(800, 600);
    expect(renderHook(() => useWidthClass()).result.current).toBe("medium");
    window_(915, 600);
    expect(renderHook(() => useWidthClass()).result.current).toBe("expanded");
  });

  it("is compact below 600px wide however tall the window is", () => {
    window_(599, 1200);
    expect(renderHook(() => useWidthClass()).result.current).toBe("compact");
  });
});

describe("useWidthClass with the layout off", () => {
  it("is compact at every size once the device says Off, and follows the window again on Auto", () => {
    window_(1200, 900);
    setWideLayoutMode("off");
    expect(renderHook(() => useWidthClass()).result.current).toBe("compact");
    setWideLayoutMode("auto");
    expect(renderHook(() => useWidthClass()).result.current).toBe("expanded");
  });
});

describe("useWidthClass while the soft keyboard shrinks the window (issue 751)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays medium when the keyboard takes a 707 by 739 window to 707 by 432 with the composer focused", () => {
    window_(707, 739);
    const field = focusedField();
    const { result } = renderHook(() => useWidthClass());
    expect(result.current).toBe("medium");
    resize_(707, 432);
    expect(result.current).toBe("medium");
    act(() => field.blur());
    expect(result.current).toBe("medium");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("compact");
  });

  it("stays medium through the blur when the height returns before the second ends", () => {
    window_(707, 739);
    const field = focusedField();
    const { result } = renderHook(() => useWidthClass());
    resize_(707, 432);
    act(() => field.blur());
    expect(result.current).toBe("medium");
    resize_(707, 739);
    expect(result.current).toBe("medium");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("medium");
  });

  it("a phone held sideways stays compact when its composer takes focus", () => {
    window_(915, 412);
    focusedField();
    expect(renderHook(() => useWidthClass()).result.current).toBe("compact");
  });

  it("drops to compact under 480 tall with no field in focus", () => {
    window_(707, 739);
    const { result } = renderHook(() => useWidthClass());
    expect(result.current).toBe("medium");
    resize_(707, 432);
    expect(result.current).toBe("compact");
  });

  it("is compact with the layout off even with a focused field", () => {
    window_(707, 739);
    focusedField();
    setWideLayoutMode("off");
    const { result } = renderHook(() => useWidthClass());
    resize_(707, 432);
    expect(result.current).toBe("compact");
  });
});
