import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { currentMarkId, resolveMarkId, useMarkId } from "@/lib/mark";
import type { MarkId } from "@/lib/mark-ids";
import { LIBRARY_STORAGE_KEY, __resetThemeStore, setActiveTheme } from "@/lib/theme/store";
import { __resetTrial, endTrial, startTrial } from "@/lib/theme/trial";
import type { Theme } from "@/lib/theme/schema";

// Which header mark the app draws: the worn theme's character, else Collie. There is no device choice.
// A theme being TRIED is the worn theme, so it wins over the stored one even when it names none.

function theme(id: string, character?: MarkId): Theme {
  const base: Theme = { version: 1, id, name: id, light: { background: "#fdfaf3" } };
  if (character === undefined) return base;
  return { ...base, version: 4, character };
}

const COLLIE = theme("base");

describe("resolveMarkId", () => {
  it("falls to Collie when the theme names no character", () => {
    expect(resolveMarkId({ trial: null, active: COLLIE })).toBe("collie");
  });

  it("takes the active theme's character", () => {
    expect(resolveMarkId({ trial: null, active: theme("a", "kawaii") })).toBe("kawaii");
  });

  it("lets a trial replace the stored theme, even a trial that names no character", () => {
    expect(resolveMarkId({ trial: theme("t", "pixel"), active: theme("a", "kawaii") })).toBe("pixel");
    expect(resolveMarkId({ trial: theme("t"), active: theme("a", "kawaii") })).toBe("collie");
  });
});

describe("the stores behind it", () => {
  beforeEach(() => {
    endTrial();
    localStorage.clear();
    sessionStorage.clear();
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

  it("follows the active imported theme, live", () => {
    importLibrary(theme("sunroom", "kawaii"));
    const { result } = renderHook(() => useMarkId());
    expect(result.current).toBe("collie");
    act(() => setActiveTheme("sunroom"));
    expect(result.current).toBe("kawaii");
    expect(currentMarkId()).toBe("kawaii");
  });

  it("ignores a device mark a build of this branch once stored, because no device choice exists", () => {
    localStorage.setItem("collie:design:v1", JSON.stringify({ font: "atkinson", mark: "pixel" }));
    importLibrary(theme("sunroom", "kawaii"));
    act(() => setActiveTheme("sunroom"));
    expect(renderHook(() => useMarkId()).result.current).toBe("kawaii");
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
});
