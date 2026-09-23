import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  coerceDashPrefs,
  COLLAPSE_THRESHOLD,
  openForCount,
  useDashPrefs,
} from "./use-dash-prefs";

describe("openForCount", () => {
  it("starts expanded on a small install", () => {
    expect(openForCount(null, 2)).toBe(true);
    expect(openForCount(null, COLLAPSE_THRESHOLD)).toBe(true);
  });

  it("starts collapsed once the list is a wall", () => {
    expect(openForCount(null, COLLAPSE_THRESHOLD + 1)).toBe(false);
    expect(openForCount(null, 45)).toBe(false);
  });

  it("an explicit choice always beats the threshold, in both directions", () => {
    expect(openForCount(true, 45)).toBe(true);
    expect(openForCount(false, 1)).toBe(false);
  });
});

describe("coerceDashPrefs", () => {
  it("defaults an empty object", () => {
    expect(coerceDashPrefs({})).toEqual({
      spacesOpen: null,
      shellsOpen: null,
      launchOpen: null,
      recentDir: "newest",
      isolatedSpace: null,
      hiddenSpaces: [],
      changesNested: true,
      changesDepth: 2,
      changesLayout: "list",
      beltScale: 1.15,
      dashView: "panes",
    });
  });

  it("keeps valid values", () => {
    expect(
      coerceDashPrefs({
        spacesOpen: false,
        shellsOpen: true,
        launchOpen: false,
        recentDir: "oldest",
        isolatedSpace: "k1",
        hiddenSpaces: ["k2", 3, "k3"],
        changesNested: false,
        changesDepth: 4,
        changesLayout: "tree",
        beltScale: 1.5,
        dashView: "changes",
      }),
    ).toEqual({
      spacesOpen: false,
      shellsOpen: true,
      launchOpen: false,
      recentDir: "oldest",
      isolatedSpace: "k1",
      hiddenSpaces: ["k2", "k3"],
      changesNested: false,
      changesDepth: 4,
      changesLayout: "tree",
      beltScale: 1.5,
      dashView: "changes",
    });
  });

  it("keeps the Changes depth inside 1..4", () => {
    expect(coerceDashPrefs({ changesDepth: 9 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: 0 }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesDepth: "3" }).changesDepth).toBe(2);
    expect(coerceDashPrefs({ changesNested: "no" }).changesNested).toBe(true);
    expect(coerceDashPrefs({ changesLayout: "grid" }).changesLayout).toBe("list");
  });

  it("keeps the dashboard tab to the three views, Panes by default", () => {
    expect(coerceDashPrefs({ dashView: "focus" }).dashView).toBe("focus");
    expect(coerceDashPrefs({ dashView: "all" }).dashView).toBe("panes");
    expect(coerceDashPrefs({ dashView: 2 }).dashView).toBe("panes");
  });

  it("reads a pre-rename dashView value as focus (ADR 0068)", () => {
    expect(coerceDashPrefs({ dashView: "needs" }).dashView).toBe("focus");
    expect(coerceDashPrefs({ dashView: "attention" }).dashView).toBe("focus");
  });

  it("keeps the belt size to the three offered scales", () => {
    expect(coerceDashPrefs({ beltScale: 1.3 }).beltScale).toBe(1.3);
    expect(coerceDashPrefs({ beltScale: 2 }).beltScale).toBe(1.15);
    expect(coerceDashPrefs({ beltScale: "1.5" }).beltScale).toBe(1.15);
  });

  it("rejects a bogus direction rather than trusting it", () => {
    expect(coerceDashPrefs({ recentDir: "sideways" }).recentDir).toBe("newest");
  });

  it("survives garbage", () => {
    expect(coerceDashPrefs(null).recentDir).toBe("newest");
    expect(coerceDashPrefs("nope").recentDir).toBe("newest");
    expect(coerceDashPrefs({ spacesOpen: "yes" }).spacesOpen).toBeNull();
    expect(coerceDashPrefs({ launchOpen: 1 }).launchOpen).toBeNull();
  });

  it("ignores a retired `recentOpen` key from an older version's stored blob", () => {
    // The Recent fold this once toggled is gone (agent-list.tsx no longer sorts into it), so the
    // key is dropped from DashPrefs — but a device that saved it under an older Collie must still
    // parse today, with the rest of its stored choices intact.
    expect(
      coerceDashPrefs({ spacesOpen: true, recentOpen: false, recentDir: "oldest" }),
    ).toEqual({
      spacesOpen: true,
      shellsOpen: null,
      launchOpen: null,
      recentDir: "oldest",
      isolatedSpace: null,
      hiddenSpaces: [],
      changesNested: true,
      changesDepth: 2,
      changesLayout: "list",
      beltScale: 1.15,
      dashView: "panes",
    });
  });
});

describe("useDashPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the defaults", () => {
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs).toEqual({
      spacesOpen: null,
      shellsOpen: null,
      launchOpen: null,
      recentDir: "newest",
      isolatedSpace: null,
      hiddenSpaces: [],
      changesNested: true,
      changesDepth: 2,
      changesLayout: "list",
      beltScale: 1.15,
      dashView: "panes",
    });
  });

  it("persists each setting across a remount", () => {
    const first = renderHook(() => useDashPrefs());
    act(() => first.result.current.setSpacesOpen(true));
    act(() => first.result.current.setShellsOpen(true));
    act(() => first.result.current.setLaunchOpen(false));
    act(() => first.result.current.setRecentDir("oldest"));
    act(() => first.result.current.setIsolatedSpace("k1"));
    act(() => first.result.current.toggleHiddenSpace("k2"));
    act(() => first.result.current.toggleHiddenSpace("k3"));
    act(() => first.result.current.toggleHiddenSpace("k2"));
    act(() => first.result.current.setChangesNested(false));
    act(() => first.result.current.setChangesDepth(3));
    act(() => first.result.current.setChangesLayout("tree"));
    act(() => first.result.current.setBeltScale(1.3));
    act(() => first.result.current.setDashView("focus"));

    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spacesOpen: true,
      shellsOpen: true,
      launchOpen: false,
      recentDir: "oldest",
      isolatedSpace: "k1",
      hiddenSpaces: ["k3"],
      changesNested: false,
      changesDepth: 3,
      changesLayout: "tree",
      beltScale: 1.3,
      dashView: "focus",
    });
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("collie:dash-prefs:v1", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});
