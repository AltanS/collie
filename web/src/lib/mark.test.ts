import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { __resetDesign, setDesignMark } from "@/lib/design";
import { currentMarkId, resolveMarkId, useMarkId, useThemeMarkId } from "@/lib/mark";
import type { MarkId } from "@/lib/mark-ids";
import { LIBRARY_STORAGE_KEY, __resetThemeStore, setActiveTheme } from "@/lib/theme/store";
import { __resetTrial, endTrial, startTrial } from "@/lib/theme/trial";
import type { Theme } from "@/lib/theme/schema";

// Which header mark the app draws: the device's choice, else the worn theme's, else Collie. A theme
// being TRIED is the worn theme, so it wins over the stored one even when it names no mark.

function theme(id: string, character?: MarkId): Theme {
  const base: Theme = { version: 1, id, name: id, light: { background: "#fdfaf3" } };
  if (character === undefined) return base;
  return { ...base, version: 4, character };
}

const COLLIE = theme("base");

describe("resolveMarkId", () => {
  it("falls to Collie when nothing names a mark", () => {
    expect(resolveMarkId({ device: undefined, trial: null, active: COLLIE })).toBe("collie");
  });

  it("takes the active theme's mark when the device says nothing", () => {
    expect(resolveMarkId({ device: undefined, trial: null, active: theme("a", "kawaii") })).toBe("kawaii");
  });

  it("lets a device choice win over the theme, including a choice of Collie", () => {
    expect(resolveMarkId({ device: "pixel", trial: null, active: theme("a", "kawaii") })).toBe("pixel");
    expect(resolveMarkId({ device: "collie", trial: null, active: theme("a", "kawaii") })).toBe("collie");
  });

  it("lets a trial replace the stored theme, even a trial that names no mark", () => {
    expect(resolveMarkId({ device: undefined, trial: theme("t", "pixel"), active: theme("a", "kawaii") })).toBe("pixel");
    expect(resolveMarkId({ device: undefined, trial: theme("t"), active: theme("a", "kawaii") })).toBe("collie");
  });

  it("still lets the device win over a trial", () => {
    expect(resolveMarkId({ device: "kawaii", trial: theme("t", "pixel"), active: COLLIE })).toBe("kawaii");
  });
});

describe("the stores behind it", () => {
  beforeEach(() => {
    endTrial();
    localStorage.clear();
    sessionStorage.clear();
    __resetDesign();
    __resetTrial();
    __resetThemeStore();
  });

  function importLibrary(...themes: Theme[]): void {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, themes }));
    __resetThemeStore();
  }

  it("is Collie on a fresh device", () => {
    expect(currentMarkId()).toBe("collie");
    expect(renderHook(() => useMarkId()).result.current).toBe("collie");
  });

  it("follows the active imported theme and the device choice, live", () => {
    importLibrary(theme("sunroom", "kawaii"));
    const { result } = renderHook(() => useMarkId());
    expect(result.current).toBe("collie");

    act(() => setActiveTheme("sunroom"));
    expect(result.current).toBe("kawaii");
    expect(currentMarkId()).toBe("kawaii");

    act(() => setDesignMark("pixel"));
    expect(result.current).toBe("pixel");
    expect(currentMarkId()).toBe("pixel");

    act(() => setDesignMark(null));
    expect(result.current).toBe("kawaii");
  });

  it("follows a trial while it runs and goes back when it ends", () => {
    const { result } = renderHook(() => useMarkId());
    act(() => {
      startTrial(theme("tried", "pixel"));
    });
    expect(result.current).toBe("pixel");
    expect(currentMarkId()).toBe("pixel");
    act(() => endTrial());
    expect(result.current).toBe("collie");
  });

  it("gives the theme's own mark through useThemeMarkId whatever the device chose", () => {
    importLibrary(theme("sunroom", "kawaii"));
    act(() => setActiveTheme("sunroom"));
    act(() => setDesignMark("pixel"));
    expect(renderHook(() => useThemeMarkId()).result.current).toBe("kawaii");
    expect(renderHook(() => useMarkId()).result.current).toBe("pixel");
  });
});
