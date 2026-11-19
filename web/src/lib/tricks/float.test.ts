import { describe, expect, it } from "vitest";

import type { JsonObject } from "../json";

import { CHIP_STATES, FLOAT_ALONG, FLOAT_ONCE_MOTIONS, FLOAT_STAY_MOTIONS, PLACE_KINDS, SHOWS_IN_WORDS, boundSessionsOf, parseTrickDocument, type FloatMotion, type TrickPart, type WireTrickPart } from "./schema";
import {
  FLOAT_COVER,
  FLOAT_EDGE_MARGIN_PX,
  FLOAT_FLY_MAX_MS,
  FLOAT_FLY_MIN_MS,
  FLOAT_FLY_REF_PX,
  FLOAT_LANDMARKS,
  FLOAT_ONCE_EVERY_MS,
  FLOAT_ONCE_MAX_MS,
  FLOAT_ONCE_MS,
  FLOAT_SIZE_PX,
  FLOAT_STAY_MAX,
  FLOAT_TAP_PX,
  OnceQueue,
  boxDims,
  capStay,
  drawnDims,
  fitsRegion,
  floatScreenOf,
  floatsForScreen,
  flyMs,
  frameAspect,
  freeArea,
  overlaps,
  pathOf,
  perchReach,
  lastFrameAtMs,
  partSignature,
  playMs,
  readFloat,
  restOf,
  rowFor,
  safeRegion,
  spriteInBox,
  stepBox,
  afterRestOf,
  afterSpecOf,
  unit,
  visibleBox,
  within,
  type Box,
  type Dims,
  type Insets,
  type OncePath,
  type PathStep,
} from "./float";

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const PHONE: Box = { x: 0, y: 0, w: 390, h: 760 };

// The landmarks of a session at 390 px: the header, the tab strip, the bottom block with the composer, the dock.
const HEADER: Box = { x: 0, y: 0, w: 390, h: 56 };
const STRIP: Box = { x: 0, y: 56, w: 390, h: 32 };
const BOTTOM: Box = { x: 0, y: 640, w: 390, h: 120 };

/** A part as the wire stores it: JSON. These tests also send what the bridge would have refused, so no typed part is built. */
function stored(value: JsonObject): TrickPart {
  return JSON.parse(JSON.stringify(value));
}

/** The first step of a path. */
function startOf(path: OncePath): PathStep {
  const step = path.steps[0];
  if (step === undefined) throw new Error("a path has no step");
  return step;
}
function lastStep(path: OncePath): PathStep {
  const step = path.steps.at(-1);
  if (step === undefined) throw new Error("a path has no step");
  return step;
}

/** The value, or a failed test when it is null. */
function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value, got null");
  return value;
}

function floatPart(value: JsonObject, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  return { host: "m1", trick: "pet", part: "p", rev: 1, value: stored({ at: "float", id: "p", ...value }), ...extra };
}
const STAY: JsonObject = { mode: "stay", motion: "perch", sprite: { src: "media/pet.png" } };
const ONCE: JsonObject = { mode: "once", motion: "arc", sprite: { src: "media/spark.png" } };

/** A sprite that plays once, with a second sprite after it. */
const withAfter = (sprite: JsonObject, after: JsonObject | string): JsonObject => ({ ...sprite, after });

describe("the safe region", () => {
  it("is the viewport less the insets when nothing is in the way", () => {
    expect(safeRegion({ viewport: PHONE, insets: { top: 47, right: 0, bottom: 34, left: 0 }, landmarks: [] })).toEqual({ x: 0, y: 47, w: 390, h: 679 });
  });

  it("takes the largest empty rectangle between fixed landmarks, a gap clear of each", () => {
    const region = safeRegion({ viewport: PHONE, insets: NO_INSETS, landmarks: [HEADER, STRIP, BOTTOM] });
    expect(region).toEqual({ x: 0, y: 92, w: 390, h: 544 });
  });

  it("goes round a landmark in the middle of a side, to the larger side", () => {
    const fab: Box = { x: 300, y: 300, w: 60, h: 60 };
    const region = must(safeRegion({ viewport: PHONE, insets: NO_INSETS, landmarks: [fab] }));
    expect(overlaps(region, fab)).toBe(false);
    // The strip left of the fab (296 x 760) is larger than the bands above (390 x 296) and below (390 x 396).
    expect(region).toEqual({ x: 0, y: 0, w: 296, h: 760 });
  });

  it("is null when the free area is smaller than a picture needs", () => {
    expect(safeRegion({ viewport: PHONE, insets: NO_INSETS, landmarks: [{ x: 0, y: 40, w: 390, h: 680 }] })).toBeNull();
    expect(safeRegion({ viewport: { x: 0, y: 0, w: 100, h: 700 }, insets: NO_INSETS, landmarks: [] })).toBeNull();
  });

  it("follows the visual viewport when the soft keyboard has shrunk it", () => {
    const region = safeRegion({ viewport: { x: 0, y: 0, w: 390, h: 400 }, insets: NO_INSETS, landmarks: [HEADER] });
    expect(region).toEqual({ x: 0, y: 60, w: 390, h: 340 });
  });

  it("ignores a landmark with no area or outside the area", () => {
    expect(freeArea({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 0, h: 50 }, { x: 500, y: 500, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("never returns a rectangle that overlaps an obstacle, for any layout (property)", () => {
    for (let n = 0; n < 300; n++) {
      const landmarks: Box[] = Array.from({ length: 1 + (n % 6) }, (_, i) => ({
        x: Math.floor(unit(`x${n}`, i) * 330),
        y: Math.floor(unit(`y${n}`, i) * 700),
        w: 20 + Math.floor(unit(`w${n}`, i) * 200),
        h: 20 + Math.floor(unit(`h${n}`, i) * 160),
      }));
      const region = safeRegion({ viewport: PHONE, insets: NO_INSETS, landmarks });
      if (region === null) continue;
      expect(within(PHONE, region)).toBe(true);
      for (const landmark of landmarks) expect(overlaps(region, landmark), `layout ${String(n)}`).toBe(false);
    }
  });
});

describe("a picture never meets a landmark", () => {
  const insets = { top: 47, right: 0, bottom: 34, left: 0 };
  const region = must(safeRegion({ viewport: PHONE, insets, landmarks: [HEADER, STRIP, BOTTOM] }));
  const reach = perchReach(region, visibleBox(PHONE, insets));
  const landmarks = [HEADER, STRIP, BOTTOM];

  it("at every step of every once motion, for many keys", () => {
    for (const motion of FLOAT_ONCE_MOTIONS) {
      for (let n = 0; n < 60; n++) {
        const side = [FLOAT_SIZE_PX.s, FLOAT_SIZE_PX.m, FLOAT_SIZE_PX.l][n % 3] ?? 32;
        const dims: Dims = { w: side * (n % 3 === 0 ? 0.62 : 1), h: side };
        const path = pathOf({ motion, key: `m1/pet/p${String(n)}`, rev: n, dims, region });
        expect(path.durationMs).toBeLessThanOrEqual(FLOAT_ONCE_MAX_MS);
        // A fly-across's last step is past the far edge on purpose (the layer clips it); every other step of every motion stays inside.
        const inside = motion === "fly-across" ? path.steps.slice(0, -1) : path.steps;
        for (const step of inside) {
          const box = stepBox(step, dims);
          expect(within(region, box), `${motion} ${String(n)} stays in the region`).toBe(true);
          for (const landmark of landmarks) expect(overlaps(box, landmark), `${motion} ${String(n)} clear of a landmark`).toBe(false);
        }
        const offsets = path.steps.map((step) => step.offset);
        expect(offsets[0]).toBe(0);
        expect(offsets.at(-1)).toBe(1);
        expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
      }
    }
  });

  it("at every rest spot of every stay motion, edge, along, size and step", () => {
    const edges = ["top", "bottom", "left", "right"] as const;
    const sizes = ["s", "m", "l"] as const;
    for (const motion of FLOAT_STAY_MOTIONS) {
      for (const edge of edges) {
        for (const along of FLOAT_ALONG) {
          for (const opens of [undefined, "page"] as const) {
            for (let n = 0; n < 12; n++) {
              const spec = { key: `m1/pet/q${String(n)}`, motion, edge, along, size: sizes[n % 3] ?? "s", opens };
              const aspect = n % 2 === 0 ? 1 : 0.62;
              const box = boxDims(spec, aspect);
              const at = restOf(spec, region, n, aspect, reach);
              const placed = { x: at.x, y: at.y, ...box };
              // A perch may stand on the landmark's own edge (the reach), the rest stays in the region.
              expect(within(motion === "perch" ? reach : region, placed), `${motion} ${edge} ${along}`).toBe(true);
              for (const landmark of landmarks) expect(overlaps(placed, landmark), `${motion} ${edge} ${along}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it("starts a once motion at a pet and keeps every step clear of the landmarks, for pets anywhere in the region (property)", () => {
    for (const motion of FLOAT_ONCE_MOTIONS) {
      for (let n = 0; n < 60; n++) {
        const dims: Dims = { w: 72 * (n % 2 === 0 ? 0.62 : 1), h: 72 };
        const from: Box = { x: region.x + unit(`fx${String(n)}`, 1) * (region.w - 30), y: region.y + unit(`fy${String(n)}`, 2) * (region.h - 40), w: 30, h: 40 };
        const path = pathOf({ motion, key: `m1/pet/r${String(n)}`, rev: n, dims, region, from });
        // The first step is the hand itself, invisible, and may hang past the region by the pet's own spot.
        // A fly-across's last step is past the far edge on purpose (the layer clips it).
        for (const step of motion === "fly-across" ? path.steps.slice(1, -1) : path.steps.slice(1)) {
          const box = stepBox(step, dims);
          expect(within(region, box), `${motion} ${String(n)}`).toBe(true);
          for (const landmark of landmarks) expect(overlaps(box, landmark)).toBe(false);
        }
      }
    }
  });

  it("puts a perch on its own edge, standing on the landmark with no gap", () => {
    const base = { key: "m1/pet/p", motion: "perch", along: "end", size: "s", opens: undefined } as const;
    // The region is held 4 px clear of the landmarks; the reach is the region up to the landmarks' own edges.
    expect(region).toEqual({ x: 0, y: 92, w: 390, h: 544 });
    expect(reach).toEqual({ x: 0, y: 88, w: 390, h: 552 });
    expect(restOf({ ...base, edge: "top" }, region, 0, 1, reach).y).toBe(STRIP.y + STRIP.h);
    const bottom = restOf({ ...base, edge: "bottom" }, region, 0, 1, reach);
    expect(bottom.y + 32).toBe(BOTTOM.y);
    expect(restOf({ ...base, edge: "left" }, region, 0, 1, reach).x).toBe(0);
    expect(restOf({ ...base, edge: "right" }, region, 0, 1, reach).x + 32).toBe(390);
  });

  it("stands a tall picture at full height on the landmark, and a tap box does not lift it", () => {
    const base = { key: "m1/pet/p", motion: "perch", edge: "bottom", along: "end", size: "l", opens: "page" } as const;
    const aspect = 74 / 120;
    const box = boxDims(base, aspect);
    const drawn = drawnDims(base, aspect);
    expect(drawn).toEqual({ w: 72 * aspect, h: 72 });
    // The tap box is at least the tap target wide and the picture high, so the picture is inside it.
    expect(box.w).toBe(Math.max(FLOAT_TAP_PX, drawn.w));
    expect(box.h).toBe(72);
    const at = restOf(base, region, 0, aspect, reach);
    const inside = spriteInBox(base, drawn, box);
    expect(at.y + inside.y + drawn.h).toBe(BOTTOM.y);
    const small = { ...base, size: "s" } as const;
    const smallBox = boxDims(small, 1);
    expect(smallBox).toEqual({ w: FLOAT_TAP_PX, h: FLOAT_TAP_PX });
    const smallAt = restOf(small, region, 0, 1, reach);
    const smallInside = spriteInBox(small, drawnDims(small, 1), smallBox);
    // 32 px tall in a 44 px tap box: the picture is pushed to the bottom of its box, not centred.
    expect(smallAt.y + smallInside.y + 32).toBe(BOTTOM.y);
    expect(smallInside.y).toBe(12);
  });

  it("puts a perch along its edge by `along`, a margin from the corner", () => {
    const base = { key: "m1/pet/p", motion: "perch", size: "m", opens: undefined } as const;
    const w = FLOAT_SIZE_PX.m;
    const x = (along: "start" | "middle" | "end", edge: "top" | "bottom") => restOf({ ...base, edge, along }, region, 0, 1, reach).x;
    expect(x("start", "bottom")).toBe(region.x + FLOAT_EDGE_MARGIN_PX);
    expect(x("middle", "bottom")).toBe(region.x + (region.w - w) / 2);
    expect(x("end", "bottom")).toBe(region.x + region.w - w - FLOAT_EDGE_MARGIN_PX);
    expect(x("end", "top")).toBe(x("end", "bottom"));
    const y = (along: "start" | "middle" | "end", edge: "left" | "right") => restOf({ ...base, edge, along }, region, 0, 1, reach).y;
    expect(y("start", "left")).toBe(region.y + FLOAT_EDGE_MARGIN_PX);
    expect(y("middle", "right")).toBe(region.y + (region.h - w) / 2);
    expect(y("end", "left")).toBe(region.y + region.h - w - FLOAT_EDGE_MARGIN_PX);
  });

  it("keeps the anchor when the second sprite is wider: start keeps the left side, end the right side, middle the centre, and the edge stays put", () => {
    const base = { key: "m1/pet/p", motion: "perch", size: "m", opens: undefined } as const;
    const first = { first: 1, after: 3 };
    const w1 = FLOAT_SIZE_PX.m;
    const w2 = 3 * FLOAT_SIZE_PX.m;
    for (const edge of ["bottom", "top"] as const) {
      const a = (along: "start" | "middle" | "end", wide: boolean) => (wide ? afterRestOf({ ...base, edge, along }, region, 0, first, reach) : restOf({ ...base, edge, along }, region, 0, 1, reach));
      expect(a("start", true).x, edge).toBe(a("start", false).x);
      expect(a("end", true).x + w2, edge).toBe(a("end", false).x + w1);
      expect(a("middle", true).x + w2 / 2, edge).toBeCloseTo(a("middle", false).x + w1 / 2);
      for (const along of ["start", "middle", "end"] as const) expect(a(along, true).y, `${edge} ${along}`).toBe(a(along, false).y);
    }
    // A wide box on a left or right edge stays on the edge.
    expect(afterRestOf({ ...base, edge: "left", along: "end" }, region, 0, first, reach).x).toBe(reach.x);
    expect(afterRestOf({ ...base, edge: "right", along: "end" }, region, 0, first, reach).x + w2).toBe(reach.x + reach.w);
  });

  it("keeps the left side of a picture that idles or wanders, held inside the region, when its second sprite is wider", () => {
    const base = { key: "m1/pet/p", edge: "bottom", along: "end", size: "m", opens: undefined } as const;
    for (const motion of ["idle", "wander"] as const) {
      const spec = { ...base, motion };
      const was = restOf(spec, region, 0, 1, reach);
      const now = afterRestOf(spec, region, 0, { first: 1, after: 3 }, reach);
      expect(now.y).toBe(was.y);
      expect(now.x).toBeLessThanOrEqual(was.x);
      expect(now.x).toBeGreaterThanOrEqual(region.x);
      expect(now.x + 3 * FLOAT_SIZE_PX.m).toBeLessThanOrEqual(region.x + region.w + 0.01);
      if (was.x + 3 * FLOAT_SIZE_PX.m <= region.x + region.w) expect(now.x).toBe(was.x);
    }
  });

  it("does not depend on the key for a perch: the same part always stands in the same place", () => {
    const base = { motion: "perch", edge: "bottom", along: "end", size: "s", opens: undefined } as const;
    expect(restOf({ ...base, key: "m1/a/x" }, region, 0, 1, reach)).toEqual(restOf({ ...base, key: "m2/b/y" }, region, 0, 1, reach));
  });

  it("draws the three sizes 32, 48 and 72 px high, and a tap box never smaller than the picture", () => {
    expect(FLOAT_SIZE_PX).toEqual({ s: 32, m: 48, l: 72 });
    for (const size of ["s", "m", "l"] as const) {
      for (const aspect of [0.4, 1, 2.5]) {
        const drawn = drawnDims({ size }, aspect);
        const box = boxDims({ size, opens: "page" }, aspect);
        expect(drawn.h).toBe(FLOAT_SIZE_PX[size]);
        expect(box.w).toBeGreaterThanOrEqual(Math.max(drawn.w, FLOAT_TAP_PX));
        expect(box.h).toBeGreaterThanOrEqual(Math.max(drawn.h, FLOAT_TAP_PX));
        expect(boxDims({ size, opens: undefined }, aspect)).toEqual(drawn);
      }
    }
  });

  it("holds the region rules for the biggest size: it fits the smallest region, and a picture too wide for the region does not", () => {
    const smallest: Box = { x: 0, y: 0, w: 120, h: 96 };
    const big = drawnDims({ size: "l" }, 1);
    expect(fitsRegion(big, smallest)).toBe(true);
    expect(fitsRegion(big, smallest, 1.2)).toBe(true);
    expect(fitsRegion(boxDims({ size: "l", opens: "page" }, 1), smallest)).toBe(true);
    // 72 px high and 4 times as wide: 288 px does not fit a 120 px region, so it is not drawn.
    expect(fitsRegion(drawnDims({ size: "l" }, 4), smallest)).toBe(false);
    expect(fitsRegion(drawnDims({ size: "l" }, 1), { x: 0, y: 0, w: 120, h: 60 })).toBe(false);
  });

  it("keeps every once motion within the 5 s limit, and the rate limit longer than the longest of them", () => {
    for (const motion of FLOAT_ONCE_MOTIONS) expect(FLOAT_ONCE_MS[motion]).toBeLessThanOrEqual(FLOAT_ONCE_MAX_MS);
    expect(FLOAT_ONCE_MAX_MS).toBe(FLOAT_FLY_MAX_MS);
    expect(FLOAT_ONCE_EVERY_MS).toBeGreaterThan(FLOAT_ONCE_MAX_MS);
  });

  it("plays an arc and a pop about a third longer than before (2800 and 1600 ms)", () => {
    expect(FLOAT_ONCE_MS.arc).toBeGreaterThanOrEqual(2800 * 1.3);
    expect(FLOAT_ONCE_MS.arc).toBeLessThanOrEqual(2800 * 1.36);
    expect(FLOAT_ONCE_MS.pop).toBeGreaterThanOrEqual(1600 * 1.3);
    expect(FLOAT_ONCE_MS.pop).toBeLessThanOrEqual(1600 * 1.36);
    const free: Box = { x: 0, y: 92, w: 390, h: 544 };
    for (const motion of ["arc", "pop"] as const) expect(pathOf({ motion, key: "m1/pet/p", rev: 1, dims: { w: 48, h: 48 }, region: free }).durationMs).toBe(FLOAT_ONCE_MS[motion]);
  });
});

describe("the landmarks and what covers", () => {
  it("lists a data-slot for the header, the strips, the composer block and the cards", () => {
    expect(FLOAT_LANDMARKS.session).toContain('[data-slot="pane-bottom"]');
    expect(FLOAT_LANDMARKS.session).toContain('[data-slot="card-dock"]');
    expect(FLOAT_LANDMARKS.dashboard).toContain('[data-slot="tab-bar"]');
    expect(FLOAT_LANDMARKS.dashboard).toContain('[data-slot="tile-strip"]');
  });

  it("covers on a sheet, a dialog and every card that asks a question", () => {
    for (const selector of ['[role="dialog"]', '[data-slot="card-dock"]', '[data-slot="ask-card"]', '[data-slot="decision-card"]']) expect(FLOAT_COVER).toContain(selector);
  });

  it("draws on the Dashboard and a session, and nowhere else", () => {
    expect(floatScreenOf("/")).toBe("dashboard");
    expect(floatScreenOf("/pane/abc")).toBe("session");
    // The zoomed output is a reading screen: nothing floats over it.
    expect(floatScreenOf("/pane/abc/zoom")).toBeNull();
    expect(floatScreenOf("/settings")).toBeNull();
    expect(floatScreenOf("/tricks/x")).toBeNull();
  });
});

describe("reading a part", () => {
  it("reads a stay part with every default", () => {
    const spec = readFloat(floatPart(STAY));
    expect(spec).toMatchObject({ key: "m1/pet/p", trick: "m1/pet", mode: "stay", motion: "perch", edge: "bottom", frames: 1, fps: 6, size: "s", mood: "idle", opens: undefined, stale: false });
  });

  it("reads every field of a full part", () => {
    const spec = readFloat(floatPart({ ...STAY, edge: "left", along: "start", mood: "working", opens: "page", sprite: { src: "media/pet.webp", frames: 4, rows: 2, fps: 12, size: "l" } }));
    expect(spec).toMatchObject({ edge: "left", along: "start", mood: "working", opens: "page", frames: 4, rows: 2, fps: 12, size: "l", src: "media/pet.webp", id: "p" });
  });

  it("reads the along of a perch (the end by default) and the from of a once part", () => {
    expect(readFloat(floatPart(STAY))).toMatchObject({ along: "end", from: undefined, rows: 1 });
    expect(readFloat(floatPart({ ...ONCE, from: "pet" }))).toMatchObject({ mode: "once", from: "pet" });
  });

  it("leaves out a part that does not read, as a crew member on another version may send", () => {
    const bad: JsonObject[] = [
      { ...STAY, mode: "loop" },
      { ...STAY, motion: "arc" },
      { ...ONCE, motion: "perch" },
      { ...STAY, sprite: { src: "../x.png" } },
      { ...STAY, sprite: { src: "media/x.gif" } },
      { ...STAY, sprite: { src: "media/x.png", frames: 17 } },
      { ...STAY, sprite: { src: "media/x.png", fps: 13 } },
      { ...STAY, sprite: { src: "media/x.png", size: "xl" } },
      { ...STAY, sprite: { src: "media/x.png", rows: 6 } },
      { ...STAY, along: "centre" },
      { ...STAY, from: "pet" },
      { ...ONCE, from: "Not An Id" },
      { ...STAY, mood: "angry" },
      { ...STAY, edge: "middle" },
      { ...STAY, opens: "web" },
      { ...ONCE, opens: "page" },
      { ...STAY, motion: "wander", opens: "page" },
      { mode: "stay", motion: "perch" },
    ];
    for (const value of bad) expect(readFloat(floatPart(value)), JSON.stringify(value)).toBeNull();
    expect(readFloat({ host: "m1", trick: "t", part: "dashboard", rev: 1, value: stored({ at: "dashboard", id: "dashboard", item: { label: "x" } }) })).toBeNull();
  });

  it("reads the loop of a sprite: true by default, false plays the frames once", () => {
    expect(readFloat(floatPart(STAY))?.loop).toBe(true);
    expect(readFloat(floatPart({ ...STAY, sprite: { src: "media/x.png", frames: 4, loop: true } }))?.loop).toBe(true);
    expect(readFloat(floatPart({ ...STAY, sprite: { src: "media/x.png", frames: 4, loop: false } }))?.loop).toBe(false);
    expect(readFloat(floatPart({ ...STAY, sprite: { src: "media/x.png", frames: 4, loop: "no" } }))).toBeNull();
  });

  it("reads the after of a sprite that plays once, with the first sprite's size and its own sheet, and leaves out one that does not read", () => {
    const first: JsonObject = { src: "media/throw.png", frames: 4, loop: false };
    const sprite = (extra: JsonObject): JsonObject => withAfter(first, { src: "media/pose.png", ...extra });
    const spec = readFloat(floatPart({ ...STAY, sprite: { ...sprite({ frames: 3, fps: 4 }), size: "m" } }));
    expect(spec?.after).toEqual({ src: "media/pose.png", frames: 3, fps: 4, loop: true });
    expect(readFloat(floatPart({ ...STAY, sprite: sprite({ loop: false }) }))?.after?.loop).toBe(false);
    expect(readFloat(floatPart(STAY))?.after).toBeUndefined();
    expect(afterSpecOf(must(spec))).toMatchObject({ src: "media/pose.png", frames: 3, rows: 1, fps: 4, size: "m", after: undefined });
    const bad: JsonObject[] = [
      { ...STAY, sprite: { ...sprite({}), loop: true } },
      { ...STAY, sprite: withAfter({ src: "media/throw.png", frames: 4 }, { src: "media/pose.png" }) },
      { ...STAY, sprite: sprite(withAfter({ src: "media/again.png" }, { src: "media/pose.png" })) },
      { ...STAY, sprite: sprite({ rows: 2 }) },
      { ...STAY, sprite: sprite({ size: "l" }) },
      { ...STAY, sprite: sprite({ src: "media/pose.svg" }) },
      { ...STAY, sprite: sprite({ frames: 17 }) },
      { ...STAY, sprite: sprite({ fps: 13 }) },
      { ...STAY, sprite: sprite({ loop: "no" }) },
      { ...STAY, sprite: sprite({ extra: 1 }) },
      { ...STAY, sprite: withAfter(first, "media/pose.png") },
      { ...ONCE, sprite: sprite({}) },
    ];
    for (const value of bad) expect(readFloat(floatPart(value)), JSON.stringify(value)).toBeNull();
  });

  it("times a play: one pass over the frames, and the moment the last frame appears", () => {
    expect(playMs(4, 2)).toBe(2000);
    expect(lastFrameAtMs(4, 2)).toBe(1500);
    expect(lastFrameAtMs(1, 6)).toBe(0);
  });

  it("tells a re-print that says something from one that does not: the value and the binding count, the asOf and the rev do not", () => {
    const base = floatPart({ ...STAY, sprite: { src: "media/x.png", frames: 4, loop: false } });
    expect(partSignature({ ...base, rev: 9, asOf: "2030-01-01T00:00:00.000Z" })).toBe(partSignature(base));
    expect(partSignature(floatPart({ ...STAY, sprite: { src: "media/x.png", frames: 4, loop: false }, mood: "working" }))).not.toBe(partSignature(base));
    expect(partSignature({ ...base, bound: [{ session: "m1:7", instance: "ab12" }] })).not.toBe(partSignature(base));
  });

  it("keeps the stale flag of a part from a failed run", () => {
    expect(readFloat(floatPart(STAY, { stale: true }))?.stale).toBe(true);
  });
});

describe("which parts a screen shows", () => {
  const bound = (session: string, instance: string): Partial<WireTrickPart> => ({ bound: [{ session, instance }] });

  it("shows the unbound parts on the Dashboard, and no bound one", () => {
    const parts = [floatPart(STAY), floatPart({ ...STAY, sessions: ["s"] }, { trick: "other", ...bound("m1:7", "ab12") })];
    expect(floatsForScreen(parts, { dashboard: true }).map((spec) => spec.trickId)).toEqual(["pet"]);
  });

  it("shows a bound part only in the session whose key and instance match, and no unbound one", () => {
    const parts = [floatPart(STAY), floatPart({ ...STAY, sessions: ["s"] }, { trick: "other", ...bound("m1:7", "ab12") })];
    const pane = { host: "m1", paneId: "7", instance: "ab12" };
    expect(floatsForScreen(parts, { pane }).map((spec) => spec.trickId)).toEqual(["other"]);
    expect(floatsForScreen(parts, { pane: { ...pane, instance: "zz99" } })).toEqual([]);
    expect(floatsForScreen(parts, { pane: { ...pane, paneId: "8" } })).toEqual([]);
    expect(floatsForScreen(parts, { pane: { ...pane, kind: "shell" } })).toEqual([]);
    expect(floatsForScreen(parts, { pane: undefined })).toEqual([]);
  });

  it("takes one part of each mode per trick, the first", () => {
    const parts = [floatPart(STAY, { part: "a" }), floatPart({ ...STAY, motion: "idle" }, { part: "b" }), floatPart(ONCE, { part: "c" }), floatPart({ ...ONCE, motion: "pop" }, { part: "d" })];
    expect(floatsForScreen(parts, { dashboard: true }).map((spec) => spec.key)).toEqual(["m1/pet/a", "m1/pet/c"]);
  });

  it("shows at most two stay pictures at once, one per trick", () => {
    const parts = ["a", "b", "c"].map((trick) => floatPart(STAY, { trick }));
    const specs = floatsForScreen(parts, { dashboard: true });
    expect(specs).toHaveLength(3);
    expect(capStay(specs).map((spec) => spec.trickId)).toEqual(["a", "b"]);
    expect(FLOAT_STAY_MAX).toBe(2);
    expect(capStay(floatsForScreen([floatPart(ONCE)], { dashboard: true }))).toEqual([]);
  });

  it("reads the sessions of a float part as a bound one", () => {
    const part = stored({ at: "float", id: "p", mode: "stay", motion: "idle", sprite: { src: "media/a.png" }, sessions: ["m1:7"] });
    expect(boundSessionsOf(part)).toEqual(["m1:7"]);
  });
});

describe("the once queue", () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it("plays the first, holds one, and drops the rest", () => {
    const time = clock();
    const queue = new OnceQueue<{ trick: string }>(time.now);
    expect(queue.offer({ trick: "a" })).toBe("play");
    expect(queue.offer({ trick: "b" })).toBe("wait");
    expect(queue.offer({ trick: "c" })).toBe("drop");
    expect(queue.finish()).toEqual({ trick: "b" });
    expect(queue.playing).toEqual({ trick: "b" });
    expect(queue.finish()).toBeNull();
    expect(queue.playing).toBeNull();
  });

  it("lets one trick start a shot once per 15 s, and counts from the start", () => {
    const time = clock();
    const queue = new OnceQueue<{ trick: string }>(time.now);
    expect(queue.offer({ trick: "a" })).toBe("play");
    queue.finish();
    time.advance(FLOAT_ONCE_EVERY_MS - 1);
    expect(queue.offer({ trick: "a" })).toBe("drop");
    expect(queue.offer({ trick: "b" })).toBe("play");
    queue.finish();
    time.advance(1);
    expect(queue.offer({ trick: "a" })).toBe("play");
  });

  it("drops a waiting shot whose trick is limited by the time it would start", () => {
    const time = clock();
    const queue = new OnceQueue<{ trick: string }>(time.now);
    expect(queue.offer({ trick: "a" })).toBe("play");
    queue.finish();
    time.advance(FLOAT_ONCE_EVERY_MS);
    expect(queue.offer({ trick: "b" })).toBe("play");
    expect(queue.offer({ trick: "a" })).toBe("wait");
    // "a" starts at once when "b" ends: it is not limited now, so it plays.
    expect(queue.finish()).toEqual({ trick: "a" });
  });

  it("counts the rate from the moment a shot that waited for its pet really begins", () => {
    const time = clock();
    const queue = new OnceQueue<{ trick: string }>(time.now);
    expect(queue.offer({ trick: "a" })).toBe("play");
    time.advance(1200);
    queue.began("a");
    queue.finish();
    time.advance(FLOAT_ONCE_EVERY_MS - 1);
    expect(queue.offer({ trick: "a" })).toBe("drop");
    time.advance(1);
    expect(queue.offer({ trick: "a" })).toBe("play");
  });

  it("stops everything on cancel and keeps the rate", () => {
    const time = clock();
    const queue = new OnceQueue<{ trick: string }>(time.now);
    queue.offer({ trick: "a" });
    queue.offer({ trick: "b" });
    queue.cancel();
    expect(queue.playing).toBeNull();
    expect(queue.waiting).toBeNull();
    expect(queue.offer({ trick: "a" })).toBe("drop");
    expect(queue.offer({ trick: "c" })).toBe("play");
  });
});

describe("the sprite sheet", () => {
  it("cuts a frame as wide as the sheet over `frames` and as high as the sheet over `rows`: not square", () => {
    // Four 74 x 120 frames side by side, one row: the figure stands at the full height of the sheet.
    expect(frameAspect({ w: 296, h: 120 }, 4)).toBeCloseTo(74 / 120, 6);
    expect(frameAspect({ w: 296, h: 120 }, 4, 1)).toBeCloseTo(74 / 120, 6);
    // Five rows of square frames, as before, when the part says `rows`.
    expect(frameAspect({ w: 256, h: 320 }, 4, 5)).toBe(1);
    // A wide frame, a single frame, and a sheet that has not loaded.
    expect(frameAspect({ w: 160, h: 40 }, 1)).toBe(4);
    expect(frameAspect(null, 4)).toBe(1);
    expect(frameAspect({ w: 0, h: 0 }, 4)).toBe(1);
  });

  it("draws a tall frame at the full height of the size, its width following the shape", () => {
    const aspect = frameAspect({ w: 296, h: 120 }, 4);
    expect(drawnDims({ size: "m" }, aspect)).toEqual({ w: 48 * aspect, h: 48 });
    expect(drawnDims({ size: "l" }, aspect).h).toBe(72);
  });

  it("draws the mood's row, or the first when the sheet has fewer", () => {
    expect(rowFor("idle", 1)).toBe(0);
    expect(rowFor(CHIP_STATES[2] ?? "idle", 1)).toBe(0);
    expect(rowFor(CHIP_STATES[2] ?? "idle", 5)).toBe(2);
  });
});

describe("the words", () => {
  it("says what the place shows", () => {
    expect(SHOWS_IN_WORDS.float).toBe("a small moving picture over the app");
  });

  it("knows every motion of each mode", () => {
    const all: readonly FloatMotion[] = [...FLOAT_ONCE_MOTIONS, ...FLOAT_STAY_MOTIONS];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("the float place in a document", () => {
  const doc = (part: JsonObject, v = 1) => ({ v, parts: [{ at: "float", id: "p", ...part }] });
  const parse = (part: JsonObject, opts: Parameters<typeof parseTrickDocument>[1] = {}, v = 1) => parseTrickDocument(doc(part, v), { contract: v, ...opts });

  it("accepts a float part only when float is in the manifest's places", () => {
    expect(parse(STAY, { places: ["float"] }).parts.map((p) => p.place)).toEqual(["float"]);
    const other = parse(STAY, { places: PLACE_KINDS.filter((place) => place !== "float") });
    expect(other.parts).toEqual([]);
    expect(other.notes.map((note) => note.code)).toEqual(["dropped"]);
    expect(parse(STAY, { declared: ["belt"] }).parts).toEqual([]);
  });

  it("reads the words of both modes and their motions", () => {
    for (const motion of FLOAT_STAY_MOTIONS) expect(parse({ ...STAY, motion }).refusals, motion).toEqual([]);
    for (const motion of FLOAT_ONCE_MOTIONS) expect(parse({ ...ONCE, motion }).refusals, motion).toEqual([]);
  });

  it("refuses a motion of the other mode, a missing sprite, and keys it does not know", () => {
    expect(parse({ ...STAY, motion: "arc" }).refusedParts.length + parse({ ...STAY, motion: "arc" }).refusals.length).toBeGreaterThan(0);
    expect(parse({ mode: "stay", motion: "idle" }).refusedParts.length + parse({ mode: "stay", motion: "idle" }).refusals.length).toBeGreaterThan(0);
    for (const extra of [{ x: 4 }, { style: "left: 0" }, { duration: 9000 }, { sprite: { src: "media/a.png", css: "x" } }]) {
      const result = parse({ ...STAY, ...extra });
      expect(result.parts.length === 1 && result.notes.length === 0, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses opens on a once part and on a wandering one, and edge without perch", () => {
    for (const part of [{ ...ONCE, opens: "page" }, { ...STAY, motion: "wander", opens: "page" }, { ...STAY, motion: "idle", edge: "top" }]) {
      const result = parse(part);
      expect(result.parts, JSON.stringify(part)).toEqual([]);
    }
    expect(parse({ ...STAY, opens: "page" }).parts).toHaveLength(1);
    expect(parse({ ...STAY, motion: "idle", opens: "page" }).parts).toHaveLength(1);
  });

  it("refuses a sprite that is no media file, too many frames, a fast fps or fps without frames", () => {
    const sprite = (extra: JsonObject) => ({ mode: "stay", motion: "idle", sprite: { src: "media/a.png", ...extra } });
    for (const bad of [{ src: "https://x.test/a.png" }, { src: "media/.hidden/a.png" }, { src: "media/a.svg" }, { frames: 17 }, { frames: 4, fps: 13 }, { fps: 6 }, { size: "xl" }]) {
      expect(parse(sprite(bad)).parts, JSON.stringify(bad)).toEqual([]);
    }
    expect(parse(sprite({ frames: 16, fps: 12, size: "l" })).parts).toHaveLength(1);
  });

  it("accepts loop as true or false on a sprite, and refuses any other value", () => {
    const sprite = (extra: JsonObject) => ({ mode: "stay", motion: "idle", sprite: { src: "media/a.png", frames: 4, ...extra } });
    expect(parse(sprite({ loop: false })).parts).toHaveLength(1);
    expect(parse(sprite({ loop: true, fps: 3 })).parts).toHaveLength(1);
    for (const bad of [{ loop: "yes" }, { loop: 0 }]) expect(parse(sprite(bad)).parts, JSON.stringify(bad)).toEqual([]);
  });

  it("reads a sprite's after: the keys src, frames, fps and loop, one level, only after loop = false, only on a stay part", () => {
    const sprite = (outer: JsonObject, after: JsonObject): JsonObject => ({ ...STAY, sprite: withAfter({ src: "media/throw.png", frames: 4, ...outer }, { src: "media/pose.png", ...after }) });
    const ok = parse(sprite({ loop: false }, { frames: 8, fps: 6, loop: false }));
    expect(ok.refusals).toEqual([]);
    expect(ok.parts).toHaveLength(1);
    const kept = ok.parts[0]?.part;
    expect(kept?.at === "float" ? kept.sprite.after : undefined).toEqual({ src: "media/pose.png", frames: 8, fps: 6, loop: false });
    expect(parse(sprite({ loop: false }, {})).parts).toHaveLength(1);
    const reasons = (value: JsonObject) => parse(value).refusals.map((r) => `${r.path} ${r.reason}`).join(" | ");
    expect(parse(sprite({}, {})).parts, "outer loop left out").toEqual([]);
    expect(reasons(sprite({}, {}))).toContain("loop");
    expect(parse(sprite({ loop: true }, {})).parts, "outer loop true").toEqual([]);
    const deep = sprite({ loop: false }, withAfter({}, { src: "media/again.png" }));
    expect(parse(deep).parts, "depth 2").toEqual([]);
    expect(reasons(deep)).toContain('no "after" of its own');
    expect(parse(sprite({ loop: false }, { rows: 2 })).parts, "rows").toEqual([]);
    expect(reasons(sprite({ loop: false }, { rows: 2 }))).toContain("rows");
    expect(parse(sprite({ loop: false }, { size: "l" })).parts, "size").toEqual([]);
    for (const bad of [{ src: "media/pose.svg" }, { src: "https://x.test/a.png" }, { frames: 17 }, { fps: 13 }, { fps: 6 }, { loop: "no" }]) {
      expect(parse(sprite({ loop: false }, bad)).parts, JSON.stringify(bad)).toEqual([]);
    }
    // A key it does not know is ignored with a note, as on the sprite itself.
    const stray = parse(sprite({ loop: false }, { extra: 1 }));
    expect(stray.parts).toHaveLength(1);
    expect(stray.notes.map((note) => note.code)).toContain("ignored");
    expect(parse({ ...STAY, sprite: withAfter({ src: "media/throw.png", frames: 4, loop: false }, "media/pose.png") }).parts, "not an object").toEqual([]);
    expect(parse({ ...ONCE, sprite: withAfter({ src: "media/spark.png", frames: 4, loop: false }, { src: "media/pose.png" }) }).parts, "once part").toEqual([]);
  });

  it("binds a float part to sessions at contract 2, and refuses it at contract 1", () => {
    const named = { ...STAY, sessions: ["m1:7"] };
    expect(parse(named, {}, 1).parts).toEqual([]);
    expect(parse(named, { contract: 2 }, 2).parts).toHaveLength(1);
  });
});

describe("a once motion that starts from a pet", () => {
  const region: Box = { x: 0, y: 92, w: 390, h: 544 };
  const dims: Dims = { w: 48, h: 48 };
  const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
  const opts = { key: "m1/pet/spark", rev: 1, dims, region };
  /** A pet: 72 px high, 44 wide, standing on the landmark below the region (the reach, 4 px past the region). */
  const petAt = (x: number, y = 640 - 72): Box => ({ x, y, w: 44, h: 72 });
  /** The box of the step at `offset`. */
  const stepAt = (path: OncePath, offset: number): PathStep => {
    const step = path.steps.find((entry) => entry.offset === offset);
    if (step === undefined) throw new Error(`no step at ${String(offset)}`);
    return step;
  };

  it("starts a fly-across with its centre on the front (right) edge of the pet at 40% of its height, flying right from the left half", () => {
    const pet = petAt(8);
    const path = pathOf({ ...opts, motion: "fly-across", from: pet });
    expect(centre(stepBox(startOf(path), dims))).toEqual({ x: pet.x + pet.w, y: pet.y + 0.4 * pet.h });
    // It flies on until it is wholly past the far edge: its box starts at the edge of the region, with no fade at the end.
    const last = stepBox(lastStep(path), dims);
    expect(last.x).toBe(region.x + region.w);
    expect(lastStep(path).opacity).toBe(1);
    // Level with the hand the whole way, and the first step is the same point as the rest.
    expect(new Set(path.steps.map((step) => step.y)).size).toBe(1);
    expect(path.steps.map((step) => step.x)).toEqual(path.steps.map((step) => step.x).toSorted((a, b) => a - b));
  });

  it("starts at the front (left) edge of a pet on the right half and flies left: away from the nearer side", () => {
    const pet = petAt(390 - 8 - 44, 300);
    const path = pathOf({ ...opts, motion: "fly-across", from: pet });
    expect(centre(stepBox(startOf(path), dims))).toEqual({ x: pet.x, y: pet.y + 0.4 * pet.h });
    const last = stepBox(lastStep(path), dims);
    expect(last.x + last.w).toBe(region.x);
    expect(lastStep(path).opacity).toBe(1);
    expect(new Set(path.steps.map((step) => step.y)).size).toBe(1);
    expect(path.steps.map((step) => step.x)).toEqual(path.steps.map((step) => step.x).toSorted((a, b) => b - a));
  });

  it("starts an arc at the hand and ends at the farther side, bending toward the side with more room", () => {
    const low = pathOf({ ...opts, motion: "arc", from: petAt(60, 520) });
    expect(centre(stepBox(startOf(low), dims))).toEqual({ x: 60 + 44, y: 520 + 0.4 * 72 });
    expect(stepBox(lastStep(low), dims).x).toBe(region.x + region.w - dims.w);
    // Near the bottom: room above is larger, so the arc rises.
    expect(Math.min(...low.steps.map((step) => step.y))).toBeLessThan(startOf(low).y);
    const high = pathOf({ ...opts, motion: "arc", from: petAt(60, 110) });
    // Near the top: room below is larger, so the arc dips.
    expect(Math.max(...high.steps.map((step) => step.y))).toBeGreaterThan(startOf(high).y);
  });

  it("opens a pop on the hand", () => {
    const pet = petAt(150, 300);
    const path = pathOf({ ...opts, motion: "pop", from: pet });
    // 150 is on the left half: the front edge is the right one.
    for (const step of path.steps) {
      const at = centre(stepBox(Object.assign({}, step, { scale: 1 }), dims));
      expect(at.x).toBeCloseTo(pet.x + pet.w, 6);
      expect(at.y).toBeCloseTo(pet.y + 0.4 * pet.h, 6);
    }
  });

  it("starts exactly at the hand of a small pet on the edge even when the box overlaps the landmark below, then eases into the region", () => {
    // A 32 px pet on the edge: its hand is 13 px below its top, so a 72 px shot centred there hangs 23 px past the region's foot.
    const pet: Box = { x: 8, y: 640 - 32, w: 32, h: 32 };
    const big: Dims = { w: 72, h: 72 };
    const path = pathOf({ ...opts, dims: big, motion: "fly-across", from: pet });
    const first = stepBox(startOf(path), big);
    expect(centre(first)).toEqual({ x: pet.x + pet.w, y: pet.y + 0.4 * pet.h });
    expect(within(region, first)).toBe(false);
    // Every step from the end of the fade-in to the one before the exit is inside the region, and all of them are level.
    const rest = path.steps.slice(1);
    for (const step of rest.slice(0, -1)) expect(within(region, stepBox(step, big))).toBe(true);
    expect(stepBox(lastStep(path), big).x).toBe(region.x + region.w);
    expect(new Set(rest.map((step) => step.y)).size).toBe(1);
    expect(startOf(path).opacity).toBe(0);
  });

  it("falls back to the normal start without a pet: the side and the height come from the key", () => {
    const plain = pathOf({ ...opts, motion: "fly-across" });
    expect(plain).toEqual(pathOf({ ...opts, motion: "fly-across", from: undefined }));
    const starts = new Set<number>();
    for (let n = 0; n < 20; n++) starts.add(startOf(pathOf({ ...opts, key: `m1/pet/k${String(n)}`, motion: "fly-across" })).x);
    // From one side or the other of the region, not from a pet.
    expect([...starts].toSorted((a, b) => a - b)).toEqual([region.x, region.x + region.w - dims.w]);
    expect(stepAt(plain, 0).opacity).toBe(0);
  });
});

describe("a fly-across leaves past the far edge, at one speed", () => {
  const region: Box = { x: 0, y: 92, w: 390, h: 544 };
  const dims: Dims = { w: 48, h: 48 };
  const key = (n: number) => `m1/pet/k${String(n)}`;
  const pet = (x: number): Box => ({ x, y: 640 - 72, w: 44, h: 72 });
  const fly = (extra: { key?: string; from?: Box; region?: Box; dims?: Dims } = {}) => pathOf({ motion: "fly-across", key: key(1), rev: 1, dims, region, ...extra });

  it("ends with the picture wholly outside the region, in the direction of travel, for a default start in both directions", () => {
    const ends = new Set<string>();
    for (let n = 0; n < 40; n++) {
      const path = fly({ key: key(n) });
      const first = stepBox(startOf(path), dims);
      const last = stepBox(lastStep(path), dims);
      const right = first.x < region.x + region.w / 2;
      ends.add(right ? "right" : "left");
      if (right) expect(last.x).toBe(region.x + region.w);
      else expect(last.x + last.w).toBe(region.x);
      expect(within(region, last)).toBe(false);
      expect(overlaps(region, last)).toBe(false);
    }
    expect([...ends].toSorted()).toEqual(["left", "right"]);
  });

  it("ends wholly outside the region for a start at a pet, both ways", () => {
    const right = stepBox(lastStep(fly({ from: pet(8) })), dims);
    expect(right.x).toBe(region.x + region.w);
    const left = stepBox(lastStep(fly({ from: pet(390 - 8 - 44) })), dims);
    expect(left.x + left.w).toBe(region.x);
    for (const end of [right, left]) expect(overlaps(region, end)).toBe(false);
  });

  it("does not fade at the end: the picture is fully visible to the last step, and fades in only at the start", () => {
    for (const from of [undefined, pet(8), pet(300)]) {
      const path = fly(from === undefined ? {} : { from });
      expect(startOf(path).opacity).toBe(0);
      expect(path.steps.slice(1).map((step) => step.opacity)).toEqual(path.steps.slice(1).map(() => 1));
    }
  });

  it("keeps the start as it was: a from-start is exact at the hand, a default start is at the near edge", () => {
    const p = pet(8);
    expect(stepBox(startOf(fly({ from: p })), dims)).toMatchObject({ x: p.x + p.w - 24, y: p.y + 0.4 * p.h - 24 });
    expect([region.x, region.x + region.w - dims.w]).toContain(startOf(fly()).x);
  });

  it("moves at one even speed from the first step to the last, and at the speed of the reference crossing when it is not held", () => {
    const path = fly();
    const [a, b, c] = path.steps;
    const rate = (one: PathStep, two: PathStep) => Math.abs(two.x - one.x) / ((two.offset - one.offset) * path.durationMs);
    expect(rate(a!, b!)).toBeCloseTo(rate(b!, c!), 9);
    expect(rate(a!, c!)).toBeCloseTo(FLOAT_FLY_REF_PX / FLOAT_ONCE_MS["fly-across"], 9);
    // After the first step of a from-start (the exact hand) the rest is one straight line in time as well.
    const from = fly({ from: pet(8) });
    const [, p, q] = from.steps;
    expect(Math.abs(q!.x - p!.x) / ((1 - 0.12) * from.durationMs)).toBeCloseTo(Math.abs(q!.x - startOf(from).x) / from.durationMs, 0);
  });

  it("takes its path over one speed: a 390 px crossing is 3200 ms, a longer path longer, a shorter one shorter, held between 2 s and 5 s", () => {
    expect(FLOAT_FLY_REF_PX).toBe(390);
    expect(flyMs(390)).toBe(3200);
    expect(flyMs(-390)).toBe(3200);
    expect(flyMs(195)).toBe(FLOAT_FLY_MIN_MS);
    expect(flyMs(0)).toBe(FLOAT_FLY_MIN_MS);
    expect(flyMs(1000)).toBe(FLOAT_FLY_MAX_MS);
    expect(flyMs(500)).toBeGreaterThan(flyMs(450));
    expect(flyMs(500)).toBe(Math.round((500 * 3200) / 390));
    // A default start crosses the whole width of the region: a 390 px region takes 3200 ms, a 300 px one 2462 ms, a 600 px one 4923 ms.
    expect(fly().durationMs).toBe(3200);
    expect(fly({ region: { ...region, w: 300 } }).durationMs).toBe(Math.round((300 * 3200) / 390));
    expect(fly({ region: { ...region, w: 600 } }).durationMs).toBe(Math.round((600 * 3200) / 390));
    // A start at a pet near the middle has about half the way and is held at the shortest time.
    const mid = fly({ from: pet(150) });
    expect(mid.durationMs).toBeGreaterThanOrEqual(FLOAT_FLY_MIN_MS);
    expect(mid.durationMs).toBeLessThan(3200);
    // A path from a pet near an edge to the far side is longer than a default crossing's visible part, and the rate limit outlasts every flight.
    for (const w of [120, 390, 800, 2000]) {
      const ms = fly({ region: { ...region, w } }).durationMs;
      expect(ms).toBeGreaterThanOrEqual(FLOAT_FLY_MIN_MS);
      expect(ms).toBeLessThanOrEqual(FLOAT_FLY_MAX_MS);
      expect(ms).toBeLessThan(FLOAT_ONCE_EVERY_MS);
    }
  });
});

describe("the from and along words in a document", () => {
  const parts = (...list: JsonObject[]) => ({ v: 1, parts: list.map((part, i) => Object.assign({ at: "float", id: `p${String(i)}` }, part)) });
  const STAY_ID = (id: string, extra: JsonObject = {}): JsonObject => ({ ...STAY, id, ...extra });
  const parse = (...list: JsonObject[]) => parseTrickDocument(parts(...list), { contract: 1 });

  it("keeps a once part whose from names a stay part of the trick, before or after it", () => {
    const stay = STAY_ID("pet");
    const once = { ...ONCE, id: "beam", from: "pet" };
    for (const order of [[stay, once], [once, stay]]) {
      const result = parseTrickDocument({ v: 1, parts: order.map((part) => Object.assign({ at: "float" }, part)) }, { contract: 1 });
      expect(result.refusals).toEqual([]);
      expect(result.parts).toHaveLength(2);
    }
  });

  it("refuses a from that names no part, with a note that says so, and keeps the other part", () => {
    const result = parseTrickDocument({ v: 1, parts: [{ at: "float", ...STAY_ID("pet") }, { at: "float", ...ONCE, id: "beam", from: "ghost" }] }, { contract: 1 });
    expect(result.parts.map((part) => part.part.id)).toEqual(["pet"]);
    expect(result.refusedParts).toEqual(["beam"]);
    const refusal = result.refusals[0];
    expect(refusal).toMatchObject({ code: "target", path: "/parts/1/from", part: "beam" });
    expect(refusal?.reason).toContain('"ghost"');
    expect(refusal?.reason).toContain("no part with the id");
  });

  it("refuses a from that names a once part or a part of another place", () => {
    const once = parseTrickDocument(
      { v: 2, parts: [{ at: "float", ...ONCE, id: "first", sessions: ["m1:7"] }, { at: "float", ...ONCE, id: "beam", from: "first" }] },
      { contract: 2 },
    );
    expect(once.parts.map((part) => part.part.id)).toEqual(["first"]);
    expect(once.refusedParts).toEqual(["beam"]);
    expect(once.refusals[0]?.reason).toContain("is not a float part that stays");
    const other = parseTrickDocument({ v: 1, parts: [{ at: "dashboard", id: "dashboard", item: { label: "x" } }, { at: "float", ...ONCE, id: "beam", from: "dashboard" }] }, { contract: 1 });
    expect(other.parts.map((part) => part.part.id)).toEqual(["dashboard"]);
    expect(other.refusals[0]?.reason).toContain("is not a float part that stays");
    expect(other.refusals[0]?.path).toBe("/parts/1/from");
  });

  it("refuses a from on a stay part, a from that is no id, and along on a part that does not perch", () => {
    for (const part of [{ ...STAY_ID("pet2"), from: "pet" }, { ...ONCE, id: "beam", from: "Not An Id" }, { ...STAY_ID("pet3"), motion: "idle", along: "end" }]) {
      const result = parseTrickDocument({ v: 1, parts: [{ at: "float", ...STAY_ID("pet") }, { at: "float", ...part }] }, { contract: 1 });
      expect(result.parts.map((p) => p.part.id), JSON.stringify(part)).toEqual(["pet"]);
    }
  });

  it("reads along, size l and rows, and refuses a bad along, size or rows", () => {
    for (const along of FLOAT_ALONG) expect(parse({ ...STAY, along }).parts, along).toHaveLength(1);
    expect(parse({ ...STAY, along: "centre" }).parts).toEqual([]);
    const sprite = (extra: JsonObject) => ({ ...STAY, sprite: { src: "media/a.png", ...extra } });
    expect(parse(sprite({ size: "l", frames: 4, rows: 5 })).parts).toHaveLength(1);
    expect(parse(sprite({ rows: 6 })).parts).toEqual([]);
    expect(parse(sprite({ rows: 0 })).parts).toEqual([]);
    expect(parse(sprite({ size: "xl" })).parts).toEqual([]);
  });
});
