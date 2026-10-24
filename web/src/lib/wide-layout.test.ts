import { describe, expect, it } from "vitest";

import { paneScopeKey } from "@/lib/scope";
import type { AgentView } from "@/lib/types";
import {
  allowedPresets,
  arrive,
  columnKeyOf,
  cycleWidth,
  dropIndexAt,
  EMPTY_STRIP,
  focusIndex,
  hasWidthChoice,
  insertAt,
  isWideMode,
  landingOf,
  MIN_PANE_WIDTH,
  nextPreset,
  openBeside,
  openHere,
  presetOf,
  prune,
  removeColumn,
  scrollTargetFor,
  shownPreset,
  spaceKeyOf,
  spaceSwipe,
  wholeColumnStart,
  widthClassOf,
  type SpaceStrip,
} from "./wide-layout";

const strip = (keys: string[], focus: string | null = keys[0] ?? null): SpaceStrip => ({
  cols: keys.map((key) => ({ key, preset: "half" })),
  focus,
});
const keysOf = (s: SpaceStrip) => s.cols.map((c) => c.key);

describe("width classes", () => {
  it("cuts at 600 and 900 CSS px", () => {
    expect([343, 599, 600, 899, 900, 1280].map(widthClassOf)).toEqual(["compact", "compact", "medium", "medium", "expanded", "expanded"]);
  });
});

describe("column widths", () => {
  it("cycles 1/2, 4/5, Full and back", () => {
    expect(nextPreset("half")).toBe("fourfifths");
    expect(nextPreset("fourfifths")).toBe("full");
    expect(nextPreset("full")).toBe("half");
  });

  it("skips a preset that would fall below the minimum width", () => {
    // 500 px strip, 360 minimum: 1/2 is 250 px, 4/5 is 400 px.
    const allowed = allowedPresets(500, 360);
    expect(allowed).toEqual(["fourfifths", "full"]);
    expect(nextPreset("full", allowed)).toBe("fourfifths");
    expect(nextPreset("fourfifths", allowed)).toBe("full");
    // 440 px strip: 4/5 is 352 px, so only Full is left.
    expect(allowedPresets(440, 360)).toEqual(["full"]);
    expect(nextPreset("full", ["full"])).toBe("full");
  });

  it("allows every preset wherever wide mode holds", () => {
    for (const min of [320, 360, 400]) expect(allowedPresets(2 * min, min)).toEqual(["half", "fourfifths", "full"]);
  });

  it("is wide when the strip holds two panes at minimum width, and no sooner", () => {
    expect(MIN_PANE_WIDTH).toBe(360);
    expect(isWideMode(719)).toBe(false);
    expect(isWideMode(720)).toBe(true);
    expect(isWideMode(639, 320)).toBe(false);
    expect(isWideMode(640, 320)).toBe(true);
  });

  it("hides the width button when no choice is left", () => {
    expect(hasWidthChoice(520)).toBe(false);
    expect(hasWidthChoice(744)).toBe(true);
    expect(hasWidthChoice(720)).toBe(true);
  });

  it("draws a column at the next wider allowed preset when its own is too narrow", () => {
    expect(shownPreset("half", ["fourfifths", "full"])).toBe("fourfifths");
    expect(shownPreset("half", ["full"])).toBe("full");
    expect(shownPreset("fourfifths", ["half", "fourfifths", "full"])).toBe("fourfifths");
  });

  it("reads a stored word back only when it names a preset", () => {
    expect(presetOf("half")).toBe("half");
    expect(presetOf("wide")).toBeUndefined();
    expect(presetOf(undefined)).toBeUndefined();
  });
});

describe("keys", () => {
  const pane = (over: Partial<AgentView>): AgentView => ({
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/",
    focused: false,
    ...over,
  });

  it("keys a column on the pane's full address, so the same id on two machines is two columns", () => {
    const a = columnKeyOf(pane({ host: "a" }), { scope: {} });
    const b = columnKeyOf(pane({ host: "b" }), { scope: {} });
    expect(a).not.toBe(b);
    expect(a).toBe(paneScopeKey({ host: "a" }, "w1:p1"));
  });

  it("keys a space on its machine and its workspace", () => {
    expect(spaceKeyOf(pane({ host: "a" }), { scope: {} })).not.toBe(spaceKeyOf(pane({ host: "b" }), { scope: {} }));
    expect(spaceKeyOf(pane({}), { scope: {} })).not.toBe(spaceKeyOf(pane({ workspaceId: "w2" }), { scope: {} }));
  });
});

describe("the focus rules", () => {
  it("arriving on an open pane focuses it and changes nothing else", () => {
    const s = strip(["a", "b", "c"], "a");
    const next = arrive(s, "c");
    expect(keysOf(next)).toEqual(["a", "b", "c"]);
    expect(next.focus).toBe("c");
    expect(arrive(next, "c")).toBe(next);
  });

  it("arriving on a pane that is not a column replaces the focused column and keeps its width", () => {
    const s: SpaceStrip = { cols: [{ key: "a", preset: "half" }, { key: "b", preset: "fourfifths" }], focus: "b" };
    const next = arrive(s, "x");
    expect(next.cols).toEqual([{ key: "a", preset: "half" }, { key: "x", preset: "fourfifths" }]);
    expect(next.focus).toBe("x");
  });

  it("arriving on an empty strip makes the pane the first column", () => {
    const next = arrive(EMPTY_STRIP, "a");
    expect(next).toEqual({ cols: [{ key: "a", preset: "half" }], focus: "a" });
  });

  it("Open here replaces the focused column, and moves a pane that is a column elsewhere", () => {
    expect(keysOf(openHere(strip(["a", "b"], "a"), "x"))).toEqual(["x", "b"]);
    const moved = openHere(strip(["a", "b", "c"], "a"), "c");
    expect(keysOf(moved)).toEqual(["c", "b"]);
    expect(moved.focus).toBe("c");
  });

  it("Open beside inserts right of the focus at 1/2 and focuses it", () => {
    const s: SpaceStrip = { cols: [{ key: "a", preset: "full" }, { key: "b", preset: "full" }], focus: "a" };
    const next = openBeside(s, "x");
    expect(keysOf(next)).toEqual(["a", "x", "b"]);
    expect(next.cols[1]?.preset).toBe("half");
    expect(next.focus).toBe("x");
  });

  it("Open beside of an open pane moves it, never doubles it", () => {
    expect(keysOf(openBeside(strip(["a", "b", "c"], "a"), "c"))).toEqual(["a", "c", "b"]);
  });

  it("a drop inserts at the boundary, and a drop of an open pane moves it", () => {
    expect(keysOf(insertAt(strip(["a", "b"]), "x", 1))).toEqual(["a", "x", "b"]);
    expect(keysOf(insertAt(strip(["a", "b", "c"]), "a", 3))).toEqual(["b", "c", "a"]);
    expect(keysOf(insertAt(strip(["a", "b", "c"]), "c", 0))).toEqual(["c", "a", "b"]);
  });

  it("the width button cycles one column and leaves the focus", () => {
    const s = strip(["a", "b"], "a");
    const next = cycleWidth(s, "b", ["half", "fourfifths", "full"]);
    expect(next.cols[1]?.preset).toBe("fourfifths");
    expect(next.focus).toBe("a");
  });

  it("Remove from view keeps the last column and hands the focus to a neighbour", () => {
    const one = strip(["a"]);
    expect(removeColumn(one, "a")).toBe(one);
    expect(removeColumn(strip(["a", "b", "c"], "b"), "b")).toEqual(strip(["a", "c"], "c"));
    expect(removeColumn(strip(["a", "b", "c"], "c"), "c")).toEqual(strip(["a", "b"], "b"));
    expect(removeColumn(strip(["a", "b", "c"], "a"), "b")).toEqual(strip(["a", "c"], "a"));
  });

  it("prunes the columns a live herd no longer has, and drops a pruned focus", () => {
    const s = strip(["a", "b", "c"], "b");
    expect(prune(s, new Set(["a", "b", "c"]))).toBe(s);
    expect(prune(s, new Set(["a", "c"]))).toEqual(strip(["a", "c"], null));
    expect(focusIndex(strip(["a", "b"], "b"))).toBe(1);
  });

  it("lands on another space at its remembered focus, else its first column, else its first pane", () => {
    expect(landingOf(strip(["a", "b"], "b"), ["a", "b", "c"])).toBe("b");
    expect(landingOf(strip(["a", "b"], "z"), ["b", "c"])).toBe("b");
    expect(landingOf(EMPTY_STRIP, ["c", "d"])).toBe("c");
    expect(landingOf(EMPTY_STRIP, [])).toBeNull();
  });
});

describe("strip geometry", () => {
  it("scrolls only when the column is not fully visible, and aligns its left edge", () => {
    const lefts = [0, 300, 600];
    const widths = [300, 300, 300];
    expect(scrollTargetFor(1, lefts, widths, 0, 600, 900)).toBeNull();
    expect(scrollTargetFor(2, lefts, widths, 0, 600, 900)).toBe(300);
    expect(scrollTargetFor(0, lefts, widths, 300, 600, 900)).toBe(0);
  });

  it("finds the nearest drop boundary", () => {
    const lefts = [0, 300, 600];
    const widths = [300, 300, 300];
    expect(dropIndexAt(100, lefts, widths)).toEqual({ index: 0, at: 0 });
    expect(dropIndexAt(200, lefts, widths)).toEqual({ index: 1, at: 300 });
    expect(dropIndexAt(880, lefts, widths)).toEqual({ index: 3, at: 900 });
  });

  it("begins the strip with a whole column", () => {
    const lefts = [0, 360, 720, 1080];
    expect(wholeColumnStart(lefts, 360)).toBeNull();
    expect(wholeColumnStart(lefts, 360.4)).toBeNull();
    expect(wholeColumnStart(lefts, 100)).toBe(0);
    expect(wholeColumnStart(lefts, 250)).toBe(360);
    expect(wholeColumnStart([], 50)).toBeNull();
  });

  it("reads a vertical swipe on the space header past 40 px: up is the next space", () => {
    expect(spaceSwipe(5, -70)).toBe(1);
    expect(spaceSwipe(5, 70)).toBe(-1);
    expect(spaceSwipe(60, 50)).toBeNull();
    expect(spaceSwipe(0, 30)).toBeNull();
  });
});
