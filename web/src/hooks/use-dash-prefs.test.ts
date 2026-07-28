import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  coerceDashPrefs,
  SPACES_COLLAPSE_THRESHOLD,
  spacesOpenFor,
  useDashPrefs,
} from "./use-dash-prefs";

describe("spacesOpenFor", () => {
  it("starts expanded on a small install", () => {
    expect(spacesOpenFor(null, 2)).toBe(true);
    expect(spacesOpenFor(null, SPACES_COLLAPSE_THRESHOLD)).toBe(true);
  });

  it("starts collapsed once the list is a wall", () => {
    expect(spacesOpenFor(null, SPACES_COLLAPSE_THRESHOLD + 1)).toBe(false);
    expect(spacesOpenFor(null, 45)).toBe(false);
  });

  it("an explicit choice always beats the threshold, in both directions", () => {
    expect(spacesOpenFor(true, 45)).toBe(true);
    expect(spacesOpenFor(false, 1)).toBe(false);
  });
});

describe("coerceDashPrefs", () => {
  it("defaults an empty object", () => {
    expect(coerceDashPrefs({})).toEqual({ spacesOpen: null, recentOpen: true, recentDir: "newest" });
  });

  it("keeps valid values", () => {
    expect(coerceDashPrefs({ spacesOpen: false, recentOpen: false, recentDir: "oldest" })).toEqual({
      spacesOpen: false,
      recentOpen: false,
      recentDir: "oldest",
    });
  });

  it("rejects a bogus direction rather than trusting it", () => {
    expect(coerceDashPrefs({ recentDir: "sideways" }).recentDir).toBe("newest");
  });

  it("survives garbage", () => {
    expect(coerceDashPrefs(null).recentDir).toBe("newest");
    expect(coerceDashPrefs("nope").recentOpen).toBe(true);
    expect(coerceDashPrefs({ spacesOpen: "yes" }).spacesOpen).toBeNull();
  });
});

describe("useDashPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the defaults", () => {
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs).toEqual({
      spacesOpen: null,
      recentOpen: true,
      recentDir: "newest",
    });
  });

  it("persists each setting across a remount", () => {
    const first = renderHook(() => useDashPrefs());
    act(() => first.result.current.setSpacesOpen(true));
    act(() => first.result.current.setRecentOpen(false));
    act(() => first.result.current.setRecentDir("oldest"));

    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spacesOpen: true,
      recentOpen: false,
      recentDir: "oldest",
    });
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("collie:dash-prefs:v1", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});
