import { afterEach, describe, expect, it, vi } from "vitest";

import type { GlyphSetData } from "./glyph-data";
import {
  MAX_TRIES,
  __resetGlyphSets,
  __setGlyphLoader,
  glyphSetData,
  glyphSetSettled,
  preloadGlyphSet,
  subscribeGlyphSets,
} from "./glyphs";

// The chunk loader's failure paths (A, counsel before 1.28.0): a failed set is asked for again, a few
// times, and one subscriber that throws cannot stop the others. icon.test.tsx covers the real chunks.

const DATA: GlyphSetData = { id: "stand-in", root: {}, glyphs: {} };

afterEach(() => {
  __setGlyphLoader(null);
  __resetGlyphSets();
  vi.useRealTimers();
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("a set whose chunk fails", () => {
  it("is asked for again on the next preload, and arrives when the chunk does", async () => {
    const loader = vi.fn<(id: string) => Promise<GlyphSetData>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(DATA);
    __setGlyphLoader(loader);
    await preloadGlyphSet("phosphor");
    expect(glyphSetData("phosphor")).toBeNull();
    await preloadGlyphSet("phosphor");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(glyphSetData("phosphor")).toBe(DATA);
    // Arrived: no third fetch.
    await preloadGlyphSet("phosphor");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_TRIES} tries in one page, and never rejects`, async () => {
    const loader = vi.fn<(id: string) => Promise<GlyphSetData>>().mockRejectedValue(new Error("gone"));
    __setGlyphLoader(loader);
    for (let i = 0; i < MAX_TRIES + 2; i += 1) await expect(preloadGlyphSet("iconoir")).resolves.toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(MAX_TRIES);
  });

  it("counts tries per set: one set's failures leave another's alone", async () => {
    const loader = vi.fn<(id: string) => Promise<GlyphSetData>>((id) => (id === "iconoir" ? Promise.reject(new Error("gone")) : Promise.resolve(DATA)));
    __setGlyphLoader(loader);
    for (let i = 0; i < MAX_TRIES; i += 1) await preloadGlyphSet("iconoir");
    await preloadGlyphSet("phosphor-fill");
    expect(glyphSetData("phosphor-fill")).toBe(DATA);
  });

  it("shares one fetch between calls while it is in flight", async () => {
    let finish: (data: GlyphSetData) => void = () => undefined;
    const loader = vi.fn(() => new Promise<GlyphSetData>((resolve) => (finish = resolve)));
    __setGlyphLoader(loader);
    const first = preloadGlyphSet("phosphor-duotone");
    const second = preloadGlyphSet("phosphor-duotone");
    expect(second).toBe(first);
    finish(DATA);
    await first;
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("is asked for once more when the page comes back into view", async () => {
    const loader = vi.fn<(id: string) => Promise<GlyphSetData>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(DATA);
    __setGlyphLoader(loader);
    await preloadGlyphSet("phosphor");
    setVisibility("hidden");
    expect(loader).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(glyphSetData("phosphor")).toBe(DATA));
    expect(loader).toHaveBeenCalledTimes(2);
    // Arrived: the next visible page asks for nothing.
    setVisibility("visible");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("is not asked for on lucide", async () => {
    const loader = vi.fn(() => Promise.resolve(DATA));
    __setGlyphLoader(loader);
    await preloadGlyphSet("lucide");
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("an arrival", () => {
  it("reaches every subscriber, even after one that throws, and the fetch still resolves", async () => {
    __setGlyphLoader(() => Promise.resolve(DATA));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const heard = vi.fn();
    const stopThrower = subscribeGlyphSets(() => {
      throw new Error("a broken subscriber");
    });
    const stopHeard = subscribeGlyphSets(heard);
    await expect(preloadGlyphSet("phosphor")).resolves.toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    stopThrower();
    stopHeard();
    error.mockRestore();
  });
});

describe("the first paint's wait", () => {
  it("ends when the set arrives, and lucide waits for nothing", async () => {
    __setGlyphLoader(() => Promise.resolve(DATA));
    await glyphSetSettled("iconoir", 10_000);
    expect(glyphSetData("iconoir")).toBe(DATA);
    await expect(glyphSetSettled("lucide", 10_000)).resolves.toBeUndefined();
  });

  it("ends at the cap when the set is slow", async () => {
    vi.useFakeTimers();
    __setGlyphLoader(() => new Promise<GlyphSetData>(() => undefined));
    let settled = false;
    void glyphSetSettled("phosphor", 150).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
