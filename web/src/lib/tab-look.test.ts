import { describe, expect, it } from "vitest";

import { tabLook } from "./tab-look";

describe("tabLook", () => {
  it("is plain when the theme names no word", () => {
    expect(tabLook(undefined)).toBe("plain");
  });

  it("reads each word of the token", () => {
    expect(tabLook("plain")).toBe("plain");
    expect(tabLook("folder")).toBe("folder");
  });
});
