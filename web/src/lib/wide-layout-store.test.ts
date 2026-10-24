import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __reloadWideLayoutStore,
  __resetWideLayoutStore,
  isSidebarOpen,
  MAX_SPACES,
  setSidebarOpen,
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
