import { describe, expect, it } from "vitest";

import type { JsonObject } from "../json";

import { CHIP_STATES, FLOAT_ONCE_MOTIONS, FLOAT_STAY_MOTIONS, PLACE_KINDS, SHOWS_IN_WORDS, boundSessionsOf, parseTrickDocument, type FloatMotion, type TrickPart, type WireTrickPart } from "./schema";
import {
  FLOAT_COVER,
  FLOAT_LANDMARKS,
  FLOAT_ONCE_EVERY_MS,
  FLOAT_ONCE_MAX_MS,
  FLOAT_ONCE_MS,
  FLOAT_SIZE_PX,
  FLOAT_STAY_MAX,
  OnceQueue,
  capStay,
  floatScreenOf,
  floatsForScreen,
  freeArea,
  overlaps,
  pathOf,
  readFloat,
  restOf,
  rowFor,
  safeRegion,
  sheetRows,
  stepBox,
  unit,
  within,
  type Box,
  type Insets,
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
  const region = must(safeRegion({ viewport: PHONE, insets: { top: 47, right: 0, bottom: 34, left: 0 }, landmarks: [HEADER, STRIP, BOTTOM] }));
  const landmarks = [HEADER, STRIP, BOTTOM];

  it("at every step of every once motion, for many keys", () => {
    for (const motion of FLOAT_ONCE_MOTIONS) {
      for (let n = 0; n < 60; n++) {
        const side = n % 2 === 0 ? FLOAT_SIZE_PX.s : FLOAT_SIZE_PX.m;
        const path = pathOf({ motion, key: `m1/pet/p${String(n)}`, rev: n, side, region });
        expect(path.durationMs).toBeLessThanOrEqual(FLOAT_ONCE_MAX_MS);
        for (const step of path.steps) {
          const box = stepBox(step, side);
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

  it("at every rest spot of every stay motion, edge and step", () => {
    const edges = ["top", "bottom", "left", "right"] as const;
    for (const motion of FLOAT_STAY_MOTIONS) {
      for (const edge of edges) {
        for (const opens of [undefined, "page"] as const) {
          for (let n = 0; n < 20; n++) {
            const spec = { key: `m1/pet/q${String(n)}`, motion, edge, size: n % 2 === 0 ? ("s" as const) : ("m" as const), opens };
            const side = opens === undefined ? FLOAT_SIZE_PX[spec.size] : Math.max(FLOAT_SIZE_PX[spec.size], 44);
            const at = restOf(spec, region, n);
            const box = { x: at.x, y: at.y, w: side, h: side };
            expect(within(region, box), `${motion} ${edge}`).toBe(true);
            for (const landmark of landmarks) expect(overlaps(box, landmark)).toBe(false);
          }
        }
      }
    }
  });

  it("puts a perch on its own edge", () => {
    const base = { key: "m1/pet/p", motion: "perch", size: "s", opens: undefined } as const;
    expect(restOf({ ...base, edge: "top" }, region).y).toBe(region.y);
    expect(restOf({ ...base, edge: "bottom" }, region).y).toBe(region.y + region.h - 32);
    expect(restOf({ ...base, edge: "left" }, region).x).toBe(region.x);
    expect(restOf({ ...base, edge: "right" }, region).x).toBe(region.x + region.w - 32);
  });

  it("keeps every once motion within the 3 s limit", () => {
    for (const motion of FLOAT_ONCE_MOTIONS) expect(FLOAT_ONCE_MS[motion]).toBeLessThanOrEqual(FLOAT_ONCE_MAX_MS);
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
    const spec = readFloat(floatPart({ ...STAY, edge: "left", mood: "working", opens: "page", sprite: { src: "media/pet.webp", frames: 4, fps: 12, size: "m" } }));
    expect(spec).toMatchObject({ edge: "left", mood: "working", opens: "page", frames: 4, fps: 12, size: "m", src: "media/pet.webp" });
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
      { ...STAY, sprite: { src: "media/x.png", size: "l" } },
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

  it("lets one trick start a shot once per 60 s, and counts from the start", () => {
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
  it("counts the rows of a sheet of square frames", () => {
    expect(sheetRows(256, 64, 4)).toBe(1);
    expect(sheetRows(256, 192, 4)).toBe(3);
    expect(sheetRows(0, 0, 4)).toBe(1);
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
    for (const bad of [{ src: "https://x.test/a.png" }, { src: "media/.hidden/a.png" }, { src: "media/a.svg" }, { frames: 17 }, { frames: 4, fps: 13 }, { fps: 6 }, { size: "l" }]) {
      expect(parse(sprite(bad)).parts, JSON.stringify(bad)).toEqual([]);
    }
    expect(parse(sprite({ frames: 16, fps: 12, size: "m" })).parts).toHaveLength(1);
  });

  it("binds a float part to sessions at contract 2, and refuses it at contract 1", () => {
    const named = { ...STAY, sessions: ["m1:7"] };
    expect(parse(named, {}, 1).parts).toEqual([]);
    expect(parse(named, { contract: 2 }, 2).parts).toHaveLength(1);
  });
});
