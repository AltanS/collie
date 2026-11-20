import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reloadActionsPaletteStore, __resetActionsPaletteStore, isActionsPaletteOn, setActionsPaletteOn } from "./actions-palette-store";

const KEY = "collie:actions-palette:v1";

beforeEach(() => __resetActionsPaletteStore());
afterEach(() => __resetActionsPaletteStore());

describe("the Actions palette setting", () => {
  it("is on for a device that chose nothing", () => {
    expect(isActionsPaletteOn()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("keeps off across a reload, and on again after switching back", () => {
    setActionsPaletteOn(false);
    expect(localStorage.getItem(KEY)).toBe("off");
    __reloadActionsPaletteStore();
    expect(isActionsPaletteOn()).toBe(false);
    setActionsPaletteOn(true);
    __reloadActionsPaletteStore();
    expect(isActionsPaletteOn()).toBe(true);
  });

  it("reads an unknown stored value as on", () => {
    localStorage.setItem(KEY, "sometimes");
    __reloadActionsPaletteStore();
    expect(isActionsPaletteOn()).toBe(true);
  });

  it("resets to on and forgets the stored choice", () => {
    setActionsPaletteOn(false);
    __resetActionsPaletteStore();
    expect(isActionsPaletteOn()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
