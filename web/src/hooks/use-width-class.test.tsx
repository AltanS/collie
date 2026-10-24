import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";

import { useWidthClass } from "./use-width-class";

// A window of the given size, as a media query list answers `min-width` and `min-height` for it.
function window_(width: number, height: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    const matches = (minW === null || width >= Number(minW[1])) && (minH === null || height >= Number(minH[1]));
    // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

beforeEach(() => __resetWideLayoutStore());
afterEach(() => {
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
