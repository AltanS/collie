import { describe, expect, it } from "vitest";

import { paneScopeKey } from "@/lib/scope";
import type { AgentView } from "@/lib/types";
import {
  allowedPresets,
  arrive,
  columnKeyOf,
  cycleWidth,
  dropIndexAt,
  followTarget,
  EMPTY_STRIP,
  focusIndex,
  hasWidthChoice,
  heldWidthClass,
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
  restingScroll,
  springAt,
  springEasing,
  springRestMs,
  springRests,
  scrollTargetFor,
  shownPreset,
  spaceKeyOf,
  spaceSwipe,
  stripGeometry,
  stepWidth,
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

describe("heldWidthClass", () => {
  it("passes a wide window class through", () => {
    expect(heldWidthClass("medium", "compact", false, "medium")).toBe("medium");
    expect(heldWidthClass("expanded", "medium", true, "expanded")).toBe("expanded");
  });

  it("holds medium while a field types and the keyboard makes the window compact", () => {
    expect(heldWidthClass("compact", "medium", true, "medium")).toBe("medium");
  });

  it("clamps a held expanded class to what the width allows", () => {
    expect(heldWidthClass("compact", "expanded", true, "medium")).toBe("medium");
  });

  it("holds expanded when the width still allows it", () => {
    expect(heldWidthClass("compact", "medium", true, "expanded")).toBe("expanded");
  });

  it("drops to compact when no field types", () => {
    expect(heldWidthClass("compact", "medium", false, "medium")).toBe("compact");
  });

  it("never raises a compact class, a phone held sideways with its composer focused", () => {
    expect(heldWidthClass("compact", "compact", true, "expanded")).toBe("compact");
  });

  it("is compact when the width alone is compact", () => {
    expect(heldWidthClass("compact", "medium", true, "compact")).toBe("compact");
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
    expect(MIN_PANE_WIDTH).toBe(440);
    expect(isWideMode(879)).toBe(false);
    expect(isWideMode(880)).toBe(true);
    expect(isWideMode(639, 320)).toBe(false);
    expect(isWideMode(640, 320)).toBe(true);
  });

  it("hides the width button when no choice is left", () => {
    expect(hasWidthChoice(520)).toBe(false);
    expect(hasWidthChoice(860)).toBe(false);
    expect(hasWidthChoice(880)).toBe(true);
    expect(hasWidthChoice(1046)).toBe(true);
  });

  it("draws one full column, not 1/2 beside an empty add column, on the tablets that showed it", () => {
    // The strip is the window less the sidebar (320 at expanded) or the rail (56). At 360 these three
    // were wide mode, so a lone column stood at 1/2 with an empty add column beside it.
    expect(isWideMode(1114 - 320)).toBe(false); // a two-screen phone held sideways, 794
    expect(isWideMode(1180 - 320)).toBe(false); // an 11-inch tablet in landscape, 860
    expect(isWideMode(820 - 56)).toBe(false); // an 11-inch tablet in portrait, sidebar closed, 764
    // A 13-inch tablet in landscape still holds two panes side by side, 1046.
    expect(isWideMode(1366 - 320)).toBe(true);
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

  it("a keyboard step goes one width along and stops at the ends", () => {
    const all = ["half", "fourfifths", "full"] as const;
    const s = strip(["a", "b"], "a");
    const wider = stepWidth(s, "b", all, 1);
    expect(wider.cols[1]?.preset).toBe("fourfifths");
    expect(wider.focus).toBe("a");
    expect(stepWidth(wider, "b", all, -1).cols[1]?.preset).toBe("half");
    expect(stepWidth(s, "b", all, -1)).toBe(s);
    const full = stepWidth(stepWidth(s, "b", all, 1), "b", all, 1);
    expect(stepWidth(full, "b", all, 1)).toBe(full);
  });

  it("a keyboard step skips a width the strip is too narrow for, and ignores a column it does not have", () => {
    const s = strip(["a"], "a");
    expect(stepWidth(s, "a", ["fourfifths", "full"], 1).cols[0]?.preset).toBe("full");
    expect(stepWidth(s, "a", ["full"], 1)).toBe(s);
    expect(stepWidth(s, "zzz", ["half", "full"], 1)).toBe(s);
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

// THE GLIDE'S END (a width change eases, wide-layout.tsx): the target is computed from the final
// fractions before the columns have moved, so it must be the place the strip comes to rest without one.
// The e2e case (e2e/wide-layout.spec.ts, "a width change glides") holds the same numbers to the
// measured page at 1440px.
describe("the width glide", () => {
  const W = 1120;

  it("lays out the columns and the add column from the fractions", () => {
    expect(stripGeometry([1 / 2, 4 / 5], W, true)).toEqual({ lefts: [0, 560], widths: [560, 896], addWidth: 440, contentWidth: 1896 });
    // One column at 1/2: the add column takes the rest of the strip.
    expect(stripGeometry([1 / 2], W, true).addWidth).toBe(560);
    // A column never goes under the minimum in wide mode, so a fraction past the cut is its floor.
    expect(stripGeometry([1 / 2], 900, true).widths).toEqual([450]);
    expect(stripGeometry([1 / 2], 860, true).widths).toEqual([440]);
    // Not wide: every column is the strip's width, with no floor.
    expect(stripGeometry([1, 1], 700, false)).toEqual({ lefts: [0, 700], widths: [700, 700], addWidth: 440, contentWidth: 1840 });
  });

  it("grows the last column: the strip scrolls to its start", () => {
    // 1/2 + 1/2 at scroll 0, the second focused, then the second at 4/5.
    expect(restingScroll(stripGeometry([1 / 2, 4 / 5], W, true), 1, 0, W)).toBe(560);
    // 4/5 to Full: already at its start.
    expect(restingScroll(stripGeometry([1 / 2, 1], W, true), 1, 560, W)).toBe(560);
  });

  it("shrinks the last column: the old position is clamped to the new range first", () => {
    // Full at scroll 560 back to 1/2: the range ends at 560, the column is whole, nothing moves.
    expect(restingScroll(stripGeometry([1 / 2, 1 / 2], W, true), 1, 560, W)).toBe(560);
    // A lone Full column scrolled to the add column's start, back to 1/2: the range ends at 0.
    expect(restingScroll(stripGeometry([1 / 2], W, true), 0, 900, W)).toBe(0);
  });

  it("grows a column in view while the strip is scrolled right: the strip stays", () => {
    expect(restingScroll(stripGeometry([1 / 2, 4 / 5, 1 / 2], W, true), 1, 560, W)).toBe(560);
    expect(restingScroll(stripGeometry([1 / 2, 1, 1 / 2], W, true), 1, 560, W)).toBe(560);
  });

  it("follows the focus the way the jump did", () => {
    const lefts = [0, 560, 1120];
    const widths = [560, 560, 560];
    // Not whole: to its start.
    expect(followTarget(2, lefts, widths, 0, W, 2240)).toBe(1120);
    // Whole, the left edge on a start: nothing.
    expect(followTarget(1, lefts, widths, 560, W, 2240)).toBeNull();
    // Whole, the left edge cutting a column: the nearest start that keeps the focus whole.
    expect(followTarget(1, lefts, widths, 500, W, 2240)).toBe(560);
  });

  it("a spring starts where it was, at the speed it had", () => {
    expect(springAt(0, 560, 0, 0)).toEqual({ x: 0, v: 0 });
    const moving = springAt(100, 560, 2000, 0);
    expect(moving.x).toBeCloseTo(100, 9);
    expect(moving.v).toBeCloseTo(2000, 9);
  });

  it("from rest it never passes its end, and is within 1% by 235 ms and 0.1% by 330 ms", () => {
    let last = 0;
    for (let ms = 1; ms <= 1000; ms += 1) {
      const { x } = springAt(0, 560, 0, ms / 1000);
      expect(x).toBeGreaterThanOrEqual(last);
      expect(x).toBeLessThanOrEqual(560);
      last = x;
    }
    expect(560 - springAt(0, 560, 0, 0.235).x).toBeLessThan(5.6);
    expect(560 - springAt(0, 560, 0, 0.225).x).toBeGreaterThan(5.6);
    expect(560 - springAt(0, 560, 0, 0.33).x).toBeLessThan(0.56);
    expect(560 - springAt(0, 560, 0, 0.32).x).toBeGreaterThan(0.56);
  });

  it("its velocity is the derivative of its place", () => {
    for (const [x0, v0] of [
      [0, 0],
      [300, 1500],
      [700, -4000],
    ]) {
      for (const t of [0.01, 0.05, 0.12, 0.3]) {
        const h = 1e-6;
        const slope = (springAt(x0!, 560, v0!, t + h).x - springAt(x0!, 560, v0!, t - h).x) / (2 * h);
        expect(springAt(x0!, 560, v0!, t).v).toBeCloseTo(slope, 3);
      }
    }
  });

  it("rests within half a pixel and under half a pixel a frame", () => {
    expect(springRests({ x: 559.6, v: 20 }, 560)).toBe(true);
    expect(springRests({ x: 559.4, v: 0 }, 560)).toBe(false);
    expect(springRests({ x: 560, v: 40 }, 560)).toBe(false);
    // A fraction of a 1120px strip: 0.0004 of it is under half a pixel.
    expect(springRests({ x: 0.9996, v: 0 }, 1, 1120)).toBe(true);
    // 1/2 to Full at 1440px moves 560px: about a third of a second.
    expect(springRestMs(560)).toBeGreaterThan(300);
    expect(springRestMs(560)).toBeLessThan(380);
  });

  it("draws the spring as a CSS linear() easing that ends on 1", () => {
    const easing = springEasing(340, 4);
    expect(easing.startsWith("linear(0, ")).toBe(true);
    expect(easing.endsWith(", 1)")).toBe(true);
  });
});
