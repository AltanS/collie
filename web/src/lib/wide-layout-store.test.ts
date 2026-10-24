import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __reloadWideLayoutStore,
  __resetWideLayoutStore,
  isSidebarOpen,
  MAX_SPACES,
  setSidebarOpen,
  setWideLayoutMode,
  wideLayoutMode,
  setSpaceStrip,
  spaceStrip,
} from "./wide-layout-store";

const LAYOUT_KEY = "collie:wide-layout:v1";

beforeEach(() => __resetWideLayoutStore());
afterEach(() => __resetWideLayoutStore());

describe("the large-screen layout store", () => {
  it("keeps each space's strip apart and survives a reload", () => {
    setSpaceStrip("s1", { cols: [{ key: "a", preset: "half" }, { key: "b", preset: "full" }], focus: "b" });
    setSpaceStrip("s2", { cols: [{ key: "c", preset: "fourfifths" }], focus: "c" });
    __reloadWideLayoutStore();
    expect(spaceStrip("s1")).toEqual({ cols: [{ key: "a", preset: "half" }, { key: "b", preset: "full" }], focus: "b" });
    expect(spaceStrip("s2").focus).toBe("c");
    expect(spaceStrip("unknown")).toEqual({ cols: [], focus: null });
  });

  it("drops a bad column and a doubled key on read, not the whole strip", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        s1: { cols: [{ key: "a", preset: "half" }, { key: "a", preset: "full" }, { key: "b", preset: "huge" }, { key: 4 }], focus: "b" },
        s2: "not a strip",
      }),
    );
    __reloadWideLayoutStore();
    expect(spaceStrip("s1")).toEqual({ cols: [{ key: "a", preset: "half" }], focus: null });
    expect(spaceStrip("s2").cols).toEqual([]);
  });

  it("reads unparsable storage as an empty layout", () => {
    localStorage.setItem(LAYOUT_KEY, "{oops");
    __reloadWideLayoutStore();
    expect(spaceStrip("s1").cols).toEqual([]);
  });

  it("forgets the space written longest ago past the cap", () => {
    for (let i = 0; i <= MAX_SPACES; i += 1) setSpaceStrip(`s${i}`, { cols: [{ key: "a", preset: "half" }], focus: "a" });
    expect(spaceStrip("s0").cols).toEqual([]);
    expect(spaceStrip(`s${MAX_SPACES}`).cols).toHaveLength(1);
  });

  it("keeps the sidebar open by default and remembers it closed", () => {
    expect(isSidebarOpen()).toBe(true);
    setSidebarOpen(false);
    __reloadWideLayoutStore();
    expect(isSidebarOpen()).toBe(false);
    setSidebarOpen(true);
    __reloadWideLayoutStore();
    expect(isSidebarOpen()).toBe(true);
  });
});

describe("the large-screen layout mode", () => {
  const MODE_KEY = "collie:wide-layout-mode:v1";

  it("is auto on a device that stored nothing, and keeps off across a reload", () => {
    expect(wideLayoutMode()).toBe("auto");
    setWideLayoutMode("off");
    expect(localStorage.getItem(MODE_KEY)).toBe("off");
    __reloadWideLayoutStore();
    expect(wideLayoutMode()).toBe("off");
    setWideLayoutMode("auto");
    expect(localStorage.getItem(MODE_KEY)).toBe("auto");
    __reloadWideLayoutStore();
    expect(wideLayoutMode()).toBe("auto");
  });

  it("reads an unknown stored value as auto, and keeps the strip store's key apart", () => {
    localStorage.setItem(MODE_KEY, "sometimes");
    __reloadWideLayoutStore();
    expect(wideLayoutMode()).toBe("auto");
    setWideLayoutMode("off");
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });
});
