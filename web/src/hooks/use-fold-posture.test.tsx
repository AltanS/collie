import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOK_QUERY, TABLETOP_QUERY, useFoldPosture, usePaneFold } from "./use-fold-posture";

let matching = new Set<string>();
function stubMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      // SAFETY: a stand-in for the browser's MediaQueryList with every member the hook reads.
      ({
        matches: matching.has(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

afterEach(() => {
  matching = new Set();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("useFoldPosture", () => {
  it("is flat where the segment features do not match, as in Safari and Firefox", () => {
    stubMedia();
    expect(renderHook(() => useFoldPosture()).result.current).toBe("flat");
  });

  it("reads two stacked segments as tabletop and two side by side as book", () => {
    matching = new Set([TABLETOP_QUERY]);
    stubMedia();
    expect(renderHook(() => useFoldPosture()).result.current).toBe("tabletop");
    matching = new Set([BOOK_QUERY]);
    stubMedia();
    expect(renderHook(() => useFoldPosture()).result.current).toBe("book");
  });
});

describe("usePaneFold", () => {
  it("draws book only where the strip exists, from 600 px", () => {
    matching = new Set([BOOK_QUERY]);
    stubMedia();
    expect(renderHook(() => usePaneFold("compact")).result.current).toBe("flat");
    expect(renderHook(() => usePaneFold("medium")).result.current).toBe("book");
  });

  it("draws tabletop at every width, and drops it while the soft keyboard is up", () => {
    matching = new Set([TABLETOP_QUERY]);
    stubMedia();
    const listeners = new Set<() => void>();
    const vv = {
      width: 400,
      height: 800,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    };
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const field = document.body.appendChild(document.createElement("textarea"));
    const { result } = renderHook(() => usePaneFold("compact"));
    expect(result.current).toBe("tabletop");
    act(() => field.focus());
    vv.height = 420;
    act(() => listeners.forEach((fn) => fn()));
    expect(result.current).toBe("flat");
    vv.height = 800;
    act(() => listeners.forEach((fn) => fn()));
    expect(result.current).toBe("tabletop");
    field.remove();
  });
});
