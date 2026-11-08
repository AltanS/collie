import { describe, expect, it } from "vitest";

import { isThemeEscape, withoutThemeEscape } from "./escape";

describe("the #theme=collie escape", () => {
  it("is the word alone, or one &-joined part of the hash", () => {
    expect(isThemeEscape("#theme=collie")).toBe(true);
    expect(isThemeEscape("#a=1&theme=collie")).toBe(true);
    expect(isThemeEscape("#theme=collie&a=1")).toBe(true);
    for (const hash of ["", "#", "#theme=collies", "#theme=nightwatch", "#xtheme=collie", "?theme=collie"]) {
      expect(isThemeEscape(hash)).toBe(false);
    }
  });

  it("comes off the hash and leaves the other parts in order", () => {
    expect(withoutThemeEscape("#theme=collie")).toBe("");
    expect(withoutThemeEscape("#a=1&theme=collie&b=2")).toBe("#a=1&b=2");
  });
});
